#!/usr/bin/env python3
"""Web chat client for LM Studio's native /api/v1/chat endpoint.

Flask serves a single-page UI and relays requests to LM Studio, so any browser
on the local network can chat with the model. The API token never leaves this
server. Conversations are stored in each browser (IndexedDB), so every machine
sees only the chats that were started on it.
"""
import argparse
import base64
import io
import json
import mimetypes
import os
import re
import sys
import time
import zipfile
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import requests
from flask import Flask, Response, jsonify, render_template, request, send_file, stream_with_context

ROOT = Path(__file__).resolve().parent
IMAGE_MIMES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
               ".webp": "image/webp", ".gif": "image/gif"}

app = Flask(__name__)
CFG = {}
CONFIG_PATH = ROOT / "config.json"


# --------------------------------------------------------------------------- text encoding

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


# --------------------------------------------------------------------------- config

def load_config(path):
    with path.open(encoding="utf-8") as f:
        cfg = json.load(f)
    for key in ("url", "model", "system_prompt"):
        if not isinstance(cfg.get(key), str) or not cfg[key].strip():
            raise ValueError(f"{key} must be a nonempty string")
    if not cfg["url"].startswith(("http://", "https://")):
        raise ValueError("url must be HTTP(S)")
    for key in ("connect_timeout", "response_timeout"):
        value = cfg.get(key)
        if value is None and key == "response_timeout":
            continue  # Disable idle timeout; not a guarantee against server disconnects.
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
            raise ValueError(f"{key} must be > 0 (or null for response_timeout)")
    for key, default in (("max_file_bytes", 524288), ("max_image_bytes", 10 * 1024 * 1024),
                         ("max_pdf_bytes", 20 * 1024 * 1024), ("port", 5000)):
        value = cfg.get(key, default)
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise ValueError(f"{key} must be a positive integer")
        cfg[key] = value
    temp = cfg.get("temperature")
    if temp is not None and (isinstance(temp, bool) or not isinstance(temp, (int, float)) or not 0 <= temp <= 1):
        raise ValueError("temperature must be null or a number between 0 and 1")
    max_out = cfg.get("max_output_tokens")
    if max_out is not None and (isinstance(max_out, bool) or not isinstance(max_out, int) or max_out <= 0):
        raise ValueError("max_output_tokens must be null or a positive integer")
    personas = cfg.get("personas", [])
    if not isinstance(personas, list):
        raise ValueError("personas must be a list")
    clean = [{"name": "Default", "system_prompt": cfg["system_prompt"], "temperature": temp}]
    for p in personas:
        if not isinstance(p, dict) or not isinstance(p.get("name"), str) or not p["name"].strip() \
                or not isinstance(p.get("system_prompt"), str) or not p["system_prompt"].strip():
            raise ValueError("each persona needs a nonempty 'name' and 'system_prompt'")
        t = p.get("temperature")
        if t is not None and (isinstance(t, bool) or not isinstance(t, (int, float)) or not 0 <= t <= 1):
            raise ValueError(f"persona {p['name']!r}: temperature must be null or 0-1")
        clean = [c for c in clean if c["name"] != p["name"].strip()]
        clean.append({"name": p["name"].strip(), "system_prompt": p["system_prompt"], "temperature": t})
    cfg["personas"] = clean
    cfg.setdefault("host", "0.0.0.0")
    cfg.setdefault("markdown", True)
    cfg.setdefault("show_stats", False)
    cfg.setdefault("show_reasoning", True)
    cfg.setdefault("fix_encoding", True)
    token = cfg.get("token")
    if token is not None and not isinstance(token, str):
        raise ValueError("token must be a string or null")
    cfg["token_from_env"] = "LM_API_TOKEN" in os.environ
    cfg["token"] = os.environ.get("LM_API_TOKEN", token or "")
    return cfg


def models_url(chat_url):
    """http://host:1234/api/v1/chat -> http://host:1234/api/v1/models"""
    parts = urlsplit(chat_url)
    path = parts.path.rstrip("/")
    path = path[: -len("/chat")] + "/models" if path.endswith("/chat") else "/api/v1/models"
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def lm_headers(stream=False, token=None):
    token = CFG["token"] if token is None else token
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream" if stream else "application/json"}
    if token:  # LM Studio with authentication off needs no header at all
        headers["Authorization"] = f"Bearer {token}"
    return headers


def token_hint(token):
    if not token:
        return ""
    return "••••" + token[-4:] if len(token) >= 8 else "•" * len(token)


def save_connection_to_file(url, token):
    """Update only url/token in config.json, keeping every other key and the file's layout."""
    with CONFIG_PATH.open(encoding="utf-8") as f:
        data = json.load(f)
    data["url"] = url
    data["token"] = token
    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, CONFIG_PATH)


def check_url(url):
    if not isinstance(url, str) or not url.strip():
        raise ValueError("The LM Studio URL can't be empty.")
    url = url.strip()
    if "://" not in url:
        url = "http://" + url
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("The LM Studio URL must look like http://192.168.1.228:1234")
    if parts.path in ("", "/"):  # just host:port given -> add the chat endpoint
        url = urlunsplit((parts.scheme, parts.netloc, "/api/v1/chat", "", ""))
    return url


def probe(url, token):
    """Try GET /api/v1/models with these settings. Returns (ok, message)."""
    try:
        r = requests.get(models_url(url), headers=lm_headers(token=token), timeout=(CFG["connect_timeout"], 15))
    except requests.RequestException as exc:
        return False, f"Cannot reach {urlsplit(url).netloc}: {exc.__class__.__name__}"
    if r.status_code in (401, 403):
        return False, f"LM Studio rejected the token (HTTP {r.status_code})."
    if not r.ok:
        return False, f"LM Studio answered HTTP {r.status_code}."
    try:
        count = sum(1 for m in r.json().get("models", []) if m.get("type") == "llm")
    except (ValueError, AttributeError):
        return False, "The server answered, but not like LM Studio's /api/v1/models."
    return True, f"Connected · {count} model{'s' if count != 1 else ''} available."


# --------------------------------------------------------------------------- files

def read_upload(name, raw):
    """Turn an uploaded file into an attachment the model can receive."""
    name = Path(name or "file").name or "file"
    suffix = Path(name).suffix.lower()
    size = len(raw)
    if suffix in IMAGE_MIMES:
        if size > CFG["max_image_bytes"]:
            raise ValueError(f"{name}: image is {size:,} bytes; limit is {CFG['max_image_bytes']:,}")
        mime = IMAGE_MIMES[suffix]
        return {"name": name, "kind": "image", "size": size,
                "content": f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"}
    if suffix == ".pdf" or raw[:5] == b"%PDF-":
        if size > CFG["max_pdf_bytes"]:
            raise ValueError(f"{name}: PDF is {size:,} bytes; limit is {CFG['max_pdf_bytes']:,}")
        text = extract_pdf_text(name, raw)
        if len(text.encode("utf-8")) > CFG["max_file_bytes"]:
            raise ValueError(f"{name}: extracted text is larger than max_file_bytes "
                             f"({CFG['max_file_bytes']:,}); it would likely overflow the model context")
        return {"name": name, "kind": "pdf", "size": size, "content": text}
    if size > CFG["max_file_bytes"]:
        raise ValueError(f"{name}: file is {size:,} bytes; limit is {CFG['max_file_bytes']:,}")
    try:
        content, encoding = decode_text_file(raw)
    except ValueError as exc:
        raise ValueError(f"{name}: {exc}") from exc
    if CFG.get("fix_encoding", True):
        content = fix_mojibake(content)
    return {"name": name, "kind": "text", "size": size, "content": content, "encoding": encoding}


def extract_pdf_text(name, raw):
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise ValueError("PDF support needs the 'pypdf' package: pip install pypdf") from exc
    try:
        reader = PdfReader(io.BytesIO(raw))
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception as exc:
                raise ValueError(f"{name}: PDF is password-protected") from exc
        pages = []
        for number, page in enumerate(reader.pages, 1):
            text = (page.extract_text() or "").strip()
            if text:
                pages.append(f"--- page {number} ---\n{text}")
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"{name}: could not read PDF ({exc})") from exc
    if not pages:
        raise ValueError(f"{name}: no extractable text (scanned PDF?). OCR it first or send page images.")
    text = "\n\n".join(pages)
    return fix_mojibake(text) if CFG.get("fix_encoding", True) else text


def compose_input(message, attachments):
    """Native chat accepts string input or typed text/image input blocks."""
    if not attachments:
        return message
    chunks = []
    for item in attachments:
        if item.get("kind") == "image":
            chunks.append({"type": "image", "data_url": item["content"]})
        else:
            chunks.append({"type": "text", "content":
                           f"<file name={json.dumps(item['name'])}>\n{item['content']}\n</file>"})
    chunks.append({"type": "text", "content": message or "Please review the attached file(s)."})
    return chunks


SAFE_NAME = re.compile(r"[^A-Za-z0-9._ -]+")


def safe_filename(name, fallback):
    name = SAFE_NAME.sub("_", Path(str(name or "")).name).strip(" .")
    return name or fallback


# --------------------------------------------------------------------------- streaming

def iter_sse(response):
    """Parse Server-Sent Events, always decoding as UTF-8.

    LM Studio sends `text/event-stream` without a charset, and `requests` then
    assumes ISO-8859-1 (turning "não" into "nÃ£o"). SSE is UTF-8 by spec, so read
    raw bytes and decode each complete line ourselves: splitting at b"\\n" never
    cuts a multi-byte UTF-8 character in half.
    """
    event_name = None
    data_lines = []
    for raw in response.iter_lines(decode_unicode=False):
        if raw is None:
            continue
        line = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
        line = line.lstrip("﻿").rstrip("\r")
        if not line:
            if data_lines:
                yield event_name, "\n".join(data_lines)
            event_name, data_lines = None, []
            continue
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            event_name = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip(" "))
    if data_lines:
        yield event_name, "\n".join(data_lines)


def repair(text):
    return fix_mojibake(text) if CFG.get("fix_encoding", True) else text


def extract_answer(result):
    return "\n\n".join(
        item["content"] for item in result.get("output", [])
        if isinstance(item, dict) and item.get("type") == "message"
        and isinstance(item.get("content"), str)
    ).strip()


def extract_reasoning(result):
    return "\n\n".join(
        item["content"] for item in result.get("output", [])
        if isinstance(item, dict) and item.get("type") == "reasoning"
        and isinstance(item.get("content"), str)
    ).strip()


def ndjson(obj):
    # ASCII-only JSON (\u escapes): immune to any charset confusion on the way to the browser.
    return json.dumps(obj, ensure_ascii=True) + "\n"


def relay_chat(payload, used_previous_id):
    """Yield NDJSON events for the browser.

    No automatic retry: repeating a request after an interrupted stream may
    create duplicate replies in the server-side conversation.
    """
    started = time.monotonic()
    final = None
    errors = []
    session = requests.Session()
    try:
        yield ndjson({"type": "status", "text": "Connecting…"})
        with session.post(CFG["url"], json=payload, stream=True, headers=lm_headers(stream=True),
                          timeout=(CFG["connect_timeout"], CFG["response_timeout"])) as response:
            if not response.ok:
                body = repair(response.content[:4000].decode("utf-8", errors="replace"))[:2000]
                yield ndjson({"type": "fatal", "status": response.status_code,
                              "message": f"HTTP {response.status_code}: {body}",
                              # Nothing was generated, so resending is safe. If the old
                              # conversation ID was the problem, the UI offers a rebuild.
                              "previous_id_rejected": bool(used_previous_id) and 400 <= response.status_code < 500})
                return
            for event, raw_data in iter_sse(response):
                if raw_data == "[DONE]":
                    continue
                try:
                    data = json.loads(raw_data)
                except json.JSONDecodeError:
                    yield ndjson({"type": "fatal", "message": f"Invalid streaming event: {raw_data[:300]}"})
                    return
                event = event or data.get("type")
                if event == "message.delta":
                    chunk = data.get("content", "")
                    if isinstance(chunk, str) and chunk:
                        yield ndjson({"type": "delta", "content": chunk})
                elif event == "reasoning.delta":
                    chunk = data.get("content", "")
                    if isinstance(chunk, str) and chunk:
                        yield ndjson({"type": "reasoning", "content": chunk})
                elif event == "model_load.start":
                    yield ndjson({"type": "status", "text": "Loading model…"})
                elif event == "model_load.progress":
                    progress = data.get("progress")
                    if isinstance(progress, (int, float)):
                        yield ndjson({"type": "status", "text": f"Loading model… {progress * 100:.0f}%"})
                elif event == "prompt_processing.start":
                    yield ndjson({"type": "status", "text": "Reading prompt…"})
                elif event == "prompt_processing.progress":
                    progress = data.get("progress")
                    if isinstance(progress, (int, float)):
                        yield ndjson({"type": "status", "text": f"Reading prompt… {progress * 100:.0f}%"})
                elif event == "reasoning.start":
                    yield ndjson({"type": "status", "text": "Thinking…"})
                elif event == "message.start":
                    yield ndjson({"type": "status", "text": "Writing…"})
                elif event in ("tool_call.start", "tool_call.success", "tool_call.failure"):
                    yield ndjson({"type": "status", "text": f"Tool: {data.get('tool') or event}"})
                elif event == "error":
                    err = data.get("error") or data
                    message = err.get("message", str(err)) if isinstance(err, dict) else str(err)
                    message = repair(message)
                    errors.append(message)
                    yield ndjson({"type": "server_error", "message": message})
                elif event == "chat.end":
                    final = data.get("result")
    except requests.Timeout as exc:
        yield ndjson({"type": "fatal", "message": f"Connection/idle timeout: {exc}. "
                      "Server state is uncertain; message not automatically retried."})
        return
    except requests.ConnectionError as exc:
        yield ndjson({"type": "fatal", "message": f"Cannot reach LM Studio at {CFG['url']}: {exc}"})
        return
    except requests.RequestException as exc:
        yield ndjson({"type": "fatal", "message": f"Request failed: {exc}"})
        return
    finally:
        session.close()

    if not isinstance(final, dict):
        yield ndjson({"type": "fatal", "message": "Stream closed without chat.end (server/network interruption); "
                      "context not advanced."})
        return
    if errors:
        yield ndjson({"type": "fatal", "message": "The server reported errors; reply not saved: " + "; ".join(errors)})
        return
    answer = repair(extract_answer(final))
    if not answer:
        yield ndjson({"type": "fatal", "message": "No answer returned."})
        return
    new_id = final.get("response_id")
    stats = final.get("stats") if isinstance(final.get("stats"), dict) else {}
    yield ndjson({
        "type": "end",
        "answer": answer,
        "reasoning": repair(extract_reasoning(final)),
        "response_id": new_id if isinstance(new_id, str) and new_id.startswith("resp_") else None,
        "stats": {**stats, "elapsed_seconds": round(time.monotonic() - started, 2)},
        "model_instance_id": final.get("model_instance_id"),
    })


# --------------------------------------------------------------------------- routes

@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/config")
def public_config():
    """Everything the UI needs, except the token."""
    parts = urlsplit(CFG["url"])
    return jsonify({
        "server": parts.netloc,
        "url": CFG["url"],
        "model": CFG["model"],
        "system_prompt": CFG["system_prompt"],
        "temperature": CFG.get("temperature"),
        "markdown": bool(CFG["markdown"]),
        "show_stats": bool(CFG["show_stats"]),
        "show_reasoning": bool(CFG["show_reasoning"]),
        "fix_encoding": bool(CFG["fix_encoding"]),
        "max_output_tokens": CFG.get("max_output_tokens"),
        "personas": CFG["personas"],
        "token_set": bool(CFG["token"]),
        "token_hint": token_hint(CFG["token"]),
        "token_from_env": CFG["token_from_env"],
        "max_file_bytes": CFG["max_file_bytes"],
        "max_image_bytes": CFG["max_image_bytes"],
        "max_pdf_bytes": CFG["max_pdf_bytes"],
    })


def context_length(model):
    for inst in model.get("loaded_instances") or []:
        length = (inst.get("config") or {}).get("context_length") if isinstance(inst, dict) else None
        if isinstance(length, int) and length > 0:
            return length
    length = model.get("max_context_length")
    return length if isinstance(length, int) and length > 0 else None


@app.get("/api/models")
def list_models():
    try:
        r = requests.get(models_url(CFG["url"]), headers=lm_headers(), timeout=(CFG["connect_timeout"], 15))
        r.raise_for_status()
        data = r.json()
    except (requests.RequestException, ValueError) as exc:
        return jsonify({"error": f"Could not list models: {exc}", "models": []}), 502
    models = []
    for m in data.get("models", []) if isinstance(data, dict) else []:
        if not isinstance(m, dict) or m.get("type") != "llm" or not m.get("key"):
            continue
        caps = m.get("capabilities") or {}
        models.append({
            "key": m["key"],
            "name": m.get("display_name") or m["key"],
            "loaded": bool(m.get("loaded_instances")),
            "vision": bool(caps.get("vision")),
            "params": m.get("params_string"),
            "context_length": context_length(m),
        })
    models.sort(key=lambda m: (not m["loaded"], m["name"].lower()))
    return jsonify({"models": models})


@app.post("/api/upload")
def upload():
    files = request.files.getlist("files")
    if not files:
        return jsonify({"error": "No files received."}), 400
    items, errors = [], []
    for f in files:
        try:
            items.append(read_upload(f.filename, f.read()))
        except ValueError as exc:
            errors.append(str(exc))
    return jsonify({"items": items, "errors": errors})


@app.post("/api/chat")
def chat():
    body = request.get_json(silent=True) or {}
    message = body.get("message") if isinstance(body.get("message"), str) else ""
    attachments = body.get("attachments") if isinstance(body.get("attachments"), list) else []
    attachments = [a for a in attachments if isinstance(a, dict) and isinstance(a.get("content"), str)
                   and a.get("kind") in ("text", "pdf", "image") and isinstance(a.get("name"), str)]
    if not message.strip() and not attachments:
        return jsonify({"error": "Empty message."}), 400
    model = body.get("model") if isinstance(body.get("model"), str) and body["model"].strip() else CFG["model"]
    payload = {"model": model, "input": compose_input(message.strip(), attachments),
               "store": True, "stream": True}
    previous_id = body.get("previous_response_id")
    if isinstance(previous_id, str) and previous_id.startswith("resp_"):
        payload["previous_response_id"] = previous_id
    else:
        previous_id = None
        system_prompt = body.get("system_prompt")
        payload["system_prompt"] = system_prompt if isinstance(system_prompt, str) and system_prompt.strip() \
            else CFG["system_prompt"]
    temperature = body.get("temperature", CFG.get("temperature"))
    if isinstance(temperature, (int, float)) and not isinstance(temperature, bool) and 0 <= temperature <= 1:
        payload["temperature"] = temperature
    max_out = body.get("max_output_tokens", CFG.get("max_output_tokens"))
    if isinstance(max_out, int) and not isinstance(max_out, bool) and max_out > 0:
        payload["max_output_tokens"] = max_out
    return Response(stream_with_context(relay_chat(payload, previous_id)),
                    mimetype="application/x-ndjson; charset=utf-8",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/zip")
def make_zip():
    body = request.get_json(silent=True) or {}
    files = body.get("files") if isinstance(body.get("files"), list) else []
    if not files:
        return jsonify({"error": "Nothing to zip."}), 400
    buffer = io.BytesIO()
    used = set()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for index, f in enumerate(files, 1):
            if not isinstance(f, dict) or not isinstance(f.get("content"), str):
                continue
            name = safe_filename(f.get("name"), f"file_{index}.txt")
            stem, dot, ext = name.rpartition(".")
            candidate, n = name, 2
            while candidate.lower() in used:
                candidate = f"{stem}_{n}.{ext}" if dot else f"{name}_{n}"
                n += 1
            used.add(candidate.lower())
            zf.writestr(candidate, f["content"])
    buffer.seek(0)
    zip_name = safe_filename(body.get("zip_name"), "code.zip")
    if not zip_name.lower().endswith(".zip"):
        zip_name += ".zip"
    return send_file(buffer, mimetype="application/zip", as_attachment=True, download_name=zip_name)


@app.post("/api/connection/test")
def test_connection():
    body = request.get_json(silent=True) or {}
    try:
        url = check_url(body.get("url") or CFG["url"])
    except ValueError as exc:
        return jsonify({"ok": False, "message": str(exc)})
    token = CFG["token"] if body.get("token") is None else str(body["token"]).strip()
    if body.get("clear_token"):
        token = ""
    ok, message = probe(url, token)
    return jsonify({"ok": ok, "message": message})


@app.post("/api/connection")
def update_connection():
    """Change the LM Studio URL and/or token from the UI; saved to config.json."""
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "Expected JSON."}), 400
    try:
        url = check_url(body.get("url") or CFG["url"])
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    token = CFG["token"]
    if body.get("clear_token"):
        token = ""
    elif isinstance(body.get("token"), str) and body["token"].strip():
        token = body["token"].strip()
    try:
        save_connection_to_file(url, token)
    except (OSError, ValueError) as exc:
        return jsonify({"error": f"Could not write {CONFIG_PATH.name}: {exc}"}), 500
    CFG["url"], CFG["token"] = url, token
    note = ""
    if CFG["token_from_env"]:
        note = "Saved. Note: the LM_API_TOKEN environment variable is set and will override this token next time the server starts."
    return jsonify({"ok": True, "url": url, "server": urlsplit(url).netloc,
                    "token_set": bool(token), "token_hint": token_hint(token), "note": note})


@app.errorhandler(413)
def too_large(_):
    return jsonify({"error": "Upload too large."}), 413


# --------------------------------------------------------------------------- main

def main():
    global CFG, CONFIG_PATH
    parser = argparse.ArgumentParser(description="LM Studio web chat")
    parser.add_argument("--config", type=Path, default=ROOT / "config.json")
    parser.add_argument("--host", help="override config host (default 0.0.0.0 = whole network)")
    parser.add_argument("--port", type=int, help="override config port")
    args = parser.parse_args()
    try:
        CONFIG_PATH = args.config.resolve()
        CFG = load_config(CONFIG_PATH)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 1
    app.config["MAX_CONTENT_LENGTH"] = max(CFG["max_pdf_bytes"], CFG["max_image_bytes"]) * 3 + 8 * 1024 * 1024
    host = args.host or CFG["host"]
    port = args.port or CFG["port"]
    print(f"LM Studio: {CFG['url']}  ·  model: {CFG['model']}")
    print(f"Open http://<this-machine-ip>:{port} from any device on your network (Ctrl+C to stop).")
    app.run(host=host, port=port, threaded=True, debug=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
