"""Optional local voice features. Nothing here talks to the internet after the models
are downloaded once; if a package isn't installed, the feature simply reports itself
unavailable and the UI falls back (browser voice for TTS, no mic button for STT).

TTS: Kokoro-82M (pip install kokoro soundfile; needs espeak-ng for Portuguese)
STT: faster-whisper (pip install faster-whisper)
"""
import importlib.util
import io
import re
import threading
import wave

KOKORO_RATE = 24000
VOICES = {
    "pt": ["pf_dora", "pm_alex", "pm_santa"],
    "en": ["af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky", "am_adam", "am_michael", "am_fenrir",
           "am_puck", "bf_emma", "bf_isabella", "bm_george", "bm_fable", "bm_lewis"],
}

# --------------------------------------------------------------------------- language detection

_PT_WORDS = set("""de da do das dos que não nao para com uma um os as é e em no na nos nas por mais
como você voce isso isto esse essa este esta pelo pela ser ter são sao foi seu sua mas também tambem
já ja quando onde porque então entao sobre até ate muito pode fazer está estao estão aqui ou se
""".split())
_EN_WORDS = set("""the and is are to of you that with for this it in on be as was were not or by
from at an have has can will your what which when where how but if they their there use using
""".split())
_PT_CHARS = re.compile(r"[ãõçáéíóúâêôàÃÕÇÁÉÍÓÚÂÊÔÀ]")
_WORD = re.compile(r"[A-Za-zÀ-ÿ']+")


def detect_lang(text, hint="pt"):
    """'pt' or 'en' for one sentence. Ties keep the hint (the previous sentence's language)."""
    words = [w.lower() for w in _WORD.findall(text)]
    pt = sum(w in _PT_WORDS for w in words) + 2 * len(_PT_CHARS.findall(text))
    en = sum(w in _EN_WORDS for w in words)
    if pt == en:
        return hint if hint in ("pt", "en") else "pt"
    return "pt" if pt > en else "en"


def _wav_bytes(samples, rate):
    """float32 numpy array in [-1, 1] -> 16-bit mono WAV bytes (no soundfile needed)."""
    import numpy as np
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


# --------------------------------------------------------------------------- TTS

class KokoroTTS:
    def __init__(self, cfg):
        cfg = cfg or {}
        self.enabled = cfg.get("enabled", True)
        self.installed = importlib.util.find_spec("kokoro") is not None
        self.device = cfg.get("device")
        self.defaults = {"pt": cfg.get("voice_pt", "pf_dora"), "en": cfg.get("voice_en", "af_heart")}
        self.speed = float(cfg.get("speed", 1.0))
        self._pipes = {}
        self._lock = threading.Lock()
        self.error = None
        self.ready = False

    @property
    def available(self):
        return bool(self.enabled and self.installed and not self.error)

    def status(self):
        return {"available": self.available, "installed": self.installed, "enabled": bool(self.enabled),
                "ready": self.ready, "error": self.error, "voices": VOICES, "defaults": self.defaults,
                "speed": self.speed}

    def _pipeline(self, lang_code):
        if lang_code not in self._pipes:
            from kokoro import KPipeline
            try:
                self._pipes[lang_code] = KPipeline(lang_code=lang_code, device=self.device) if self.device \
                    else KPipeline(lang_code=lang_code)
            except TypeError:   # older kokoro without the device argument
                self._pipes[lang_code] = KPipeline(lang_code=lang_code)
        return self._pipes[lang_code]

    def warm_up(self):
        """Load both pipelines in the background so the first click isn't slow."""
        if not (self.enabled and self.installed):
            return
        try:
            with self._lock:
                for voice in self.defaults.values():
                    self._pipeline(voice[0])
            self.ready = True
        except Exception as exc:  # missing espeak-ng, failed download, ...
            self.error = f"{exc.__class__.__name__}: {exc}"

    def synthesize(self, text, voices=None, hint="pt", speed=None):
        """Returns (wav_bytes, lang, voice)."""
        import numpy as np
        lang = detect_lang(text, hint)
        voice = (voices or {}).get(lang) or self.defaults[lang]
        if voice not in VOICES["pt"] + VOICES["en"]:
            voice = self.defaults[lang]
        speed = float(speed or self.speed)
        speed = min(2.0, max(0.5, speed))
        chunks = []
        with self._lock:   # Kokoro pipelines are not thread-safe
            pipe = self._pipeline(voice[0])
            for result in pipe(text, voice=voice, speed=speed, split_pattern=r"\n+"):
                audio = result[2] if isinstance(result, tuple) else getattr(result, "audio", None)
                if audio is None:
                    continue
                if hasattr(audio, "detach"):
                    audio = audio.detach().cpu().numpy()
                chunks.append(np.asarray(audio, dtype="float32").reshape(-1))
            self.ready = True
        samples = np.concatenate(chunks) if chunks else np.zeros(1, dtype="float32")
        return _wav_bytes(samples, KOKORO_RATE), lang, voice


# --------------------------------------------------------------------------- STT

class WhisperSTT:
    def __init__(self, cfg):
        cfg = cfg or {}
        self.enabled = cfg.get("enabled", True)
        self.installed = importlib.util.find_spec("faster_whisper") is not None
        self.model_name = cfg.get("model", "small")
        self.device = cfg.get("device", "cpu")
        self.compute_type = cfg.get("compute_type", "int8")
        self.language = cfg.get("language")
        self._model = None
        self._lock = threading.Lock()
        self.error = None

    @property
    def available(self):
        return bool(self.enabled and self.installed and not self.error)

    def status(self):
        return {"available": self.available, "installed": self.installed, "enabled": bool(self.enabled),
                "ready": self._model is not None, "error": self.error, "model": self.model_name}

    def _load(self):
        if self._model is None:
            from faster_whisper import WhisperModel
            self._model = WhisperModel(self.model_name, device=self.device, compute_type=self.compute_type)
        return self._model

    def warm_up(self):
        if not (self.enabled and self.installed):
            return
        try:
            with self._lock:
                self._load()
        except Exception as exc:
            self.error = f"{exc.__class__.__name__}: {exc}"

    def transcribe(self, raw_audio, language=None):
        """raw_audio: bytes of any format PyAV can decode (webm/opus, ogg, wav, mp4...)."""
        with self._lock:
            model = self._load()
            segments, info = model.transcribe(io.BytesIO(raw_audio), language=language or self.language,
                                              vad_filter=True, beam_size=5)
            text = " ".join(s.text.strip() for s in segments).strip()
        return text, getattr(info, "language", None)
