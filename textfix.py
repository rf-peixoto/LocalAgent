"""Text-encoding helpers: repair mojibake and decode uploaded text files."""
import re


# Each character that a single byte 0x80-0xFF becomes when UTF-8 bytes are wrongly
# decoded as Latin-1 or Windows-1252 ("mojibake": "NÃ£o" instead of "Não").
_BYTE_OF = {}
for _b in range(0x80, 0x100):
    _BYTE_OF[chr(_b)] = _b
    try:
        _BYTE_OF[bytes([_b]).decode("cp1252")] = _b
    except UnicodeDecodeError:
        pass
_MOJI_HINT = re.compile("[Â-ô][\u0080-¿ŒœŠšŸŽžƒ"
                        "ˆ˜–—‘-‚“-„†-•…‰"
                        "‹›€™]")
# Only accept repairs that produce characters a real text plausibly contains, so that
# genuine text such as "Até…”" is never "repaired" into a CJK character. (U+0080-U+009F
# is the middle step of doubly broken text; the next pass turns it into the real char.)
_PLAUSIBLE = ((0x0080, 0x017F), (0x0300, 0x036F), (0x0370, 0x03FF), (0x0400, 0x04FF),
              (0x1E00, 0x1EFF), (0x2000, 0x206F), (0x20A0, 0x20CF), (0x2100, 0x27BF), (0x2900, 0x2BFF),
              (0xFE00, 0xFE0F), (0x1F000, 0x1FAFF))


def _utf8_len(lead):
    return 2 if 0xC2 <= lead <= 0xDF else 3 if 0xE0 <= lead <= 0xEF else 4 if 0xF0 <= lead <= 0xF4 else 0


def fix_mojibake(text):
    """Repair UTF-8 text that was decoded with the wrong codec (also when doubly broken)."""
    if not isinstance(text, str) or not _MOJI_HINT.search(text):
        return text
    # Windows-1252 has no character for byte 0x9D, so a broken "”" often arrives as "â€�".
    text = text.replace("\u00e2\u20ac\ufffd", "\u201d")
    for _ in range(3):
        out, i, n, changed = [], 0, len(text), False
        while i < n:
            lead = _BYTE_OF.get(text[i])
            size = _utf8_len(lead) if lead is not None else 0
            if size and i + size <= n:
                seq = [lead]
                for ch in text[i + 1:i + size]:
                    b = _BYTE_OF.get(ch)
                    if b is None or not 0x80 <= b <= 0xBF:
                        break
                    seq.append(b)
                if len(seq) == size:
                    try:
                        decoded = bytes(seq).decode("utf-8")
                    except UnicodeDecodeError:
                        decoded = None
                    if decoded and any(lo <= ord(decoded) <= hi for lo, hi in _PLAUSIBLE):
                        out.append(decoded)
                        i += size
                        changed = True
                        continue
            out.append(text[i])
            i += 1
        if not changed:
            break
        text = "".join(out)
    return text


def decode_text_file(raw):
    """Decode an uploaded text file: UTF-8, UTF-16 (BOM) or Windows-1252. Returns (text, encoding)."""
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16"), "UTF-16"
    if b"\x00" in raw:
        raise ValueError("binary files are unsupported. Send text/source files, PDFs or images.")
    try:
        return raw.decode("utf-8-sig"), "UTF-8"
    except UnicodeDecodeError:
        pass
    try:
        return raw.decode("cp1252"), "Windows-1252"
    except UnicodeDecodeError:
        return raw.decode("latin-1"), "Latin-1"
