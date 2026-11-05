#!/usr/bin/env python3
"""LOCAL//GRID — web chat client for LM Studio's native /api/v1/chat endpoint.

Flask serves a single-page UI (behind a password) and relays requests to LM Studio,
so any browser on the local network can chat with the model. The API token never
leaves this server. Conversations are stored in each browser (IndexedDB), so every
machine sees only the chats that were started on it.
"""
import argparse
import base64
import getpass
import io
import json
import os
import re
import sys
import threading
import time
import zipfile
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import requests
from flask import Flask, Response, jsonify, render_template, request, send_file, stream_with_context

sys.path.insert(0, str(Path(__file__).resolve().parent))   # find auth/voice/... however app.py is launched
import auth  # noqa: E402
from textfix import decode_text_file, fix_mojibake  # noqa: E402
from voice import KokoroTTS, WhisperSTT  # noqa: E402

ROOT = Path(__file__).resolve().parent
IMAGE_MIMES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
               ".webp": "image/webp", ".gif": "image/gif"}
REASONING_LEVELS = ("off", "low", "medium", "high", "on")
TOOL_OUTPUT_LIMIT = 20000

app = Flask(__name__)
CFG = {}
CONFIG_PATH = ROOT / "config.json"
TTS = KokoroTTS({"enabled": False})
STT = WhisperSTT({"enabled": False})
_config_lock = threading.Lock()


# --------------------------------------------------------------------------- config

def _num(value, lo=None, hi=None, integer=False):
    if isinstance(value, bool) or not isinstance(value, int if integer else (int, float)):
        return False
    return (lo is None or value >= lo) and (hi is None or value <= hi)


def _check_persona(p, label):
    t = p.get("temperature")
    if t is not None and not _num(t, 0, 1):
        raise ValueError(f"{label}: temperature must be null or 0-1")
    r = p.get("reasoning")
    if r is not None and r not in REASONING_LEVELS:
        raise ValueError(f"{label}: reasoning must be null or one of {', '.join(REASONING_LEVELS)}")
    m = p.get("model")
    if m is not None and (not isinstance(m, str) or not m.strip()):
        raise ValueError(f"{label}: model must be null or a model key")
    tools = p.get("tools")
    if tools is not None and (not isinstance(tools, list) or not all(isinstance(x, str) for x in tools)):
        raise ValueError(f"{label}: tools must be a list of integration names")
    return {"temperature": t, "reasoning": r, "model": m.strip() if m else None, "tools": tools or []}


def _check_integration(item, i):
    if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not item["name"].strip():
        raise ValueError(f"integrations[{i}] needs a 'name'")
    allowed = item.get("allowed_tools")
    if allowed is not None and (not isinstance(allowed, list) or not all(isinstance(x, str) for x in allowed)):
        raise ValueError(f"integrations[{i}].allowed_tools must be a list of tool names")
    if isinstance(item.get("id"), str) and item["id"].strip():
        spec = {"type": "plugin", "id": item["id"].strip()}
    elif isinstance(item.get("server_url"), str) and item["server_url"].startswith(("http://", "https://")):
        spec = {"type": "ephemeral_mcp", "server_label": str(item.get("server_label") or item["name"]).strip(),
                "server_url": item["server_url"]}
        headers = item.get("headers")
        if headers is not None:
            if not isinstance(headers, dict) or not all(isinstance(v, str) for v in headers.values()):
                raise ValueError(f"integrations[{i}].headers must map names to strings")
            spec["headers"] = headers
    else:
        raise ValueError(f"integrations[{i}] needs 'id' (an mcp.json plugin such as \"mcp/playwright\") "
                         "or 'server_url' (an MCP server URL)")
    if allowed:
        spec["allowed_tools"] = allowed
    return {"name": item["name"].strip(), "default": bool(item.get("default")),
            "description": str(item.get("description") or ""), "spec": spec}


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
        if not _num(value) or value <= 0:
            raise ValueError(f"{key} must be > 0 (or null for response_timeout)")
    for key, default in (("max_file_bytes", 524288), ("max_image_bytes", 10 * 1024 * 1024),
                         ("max_pdf_bytes", 20 * 1024 * 1024), ("max_audio_bytes", 25 * 1024 * 1024), ("port", 5000)):
        value = cfg.get(key, default)
        if not _num(value, 1, integer=True):
            raise ValueError(f"{key} must be a positive integer")
        cfg[key] = value
    temp = cfg.get("temperature")
    if temp is not None and not _num(temp, 0, 1):
        raise ValueError("temperature must be null or a number between 0 and 1")
    max_out = cfg.get("max_output_tokens")
    if max_out is not None and not _num(max_out, 1, integer=True):
        raise ValueError("max_output_tokens must be null or a positive integer")

    integrations = cfg.get("integrations") or []
    if not isinstance(integrations, list):
        raise ValueError("integrations must be a list")
    cfg["integrations"] = [_check_integration(x, i) for i, x in enumerate(integrations)]
    names = {x["name"] for x in cfg["integrations"]}

    personas = cfg.get("personas", [])
    if not isinstance(personas, list):
        raise ValueError("personas must be a list")
    default = {"name": "Default", "system_prompt": cfg["system_prompt"],
               **_check_persona({"temperature": temp, "reasoning": cfg.get("reasoning"),
                                 "model": None, "tools": cfg.get("default_tools")}, "default")}
    clean = [default]
    for p in personas:
        if not isinstance(p, dict) or not isinstance(p.get("name"), str) or not p["name"].strip() \
                or not isinstance(p.get("system_prompt"), str) or not p["system_prompt"].strip():
            raise ValueError("each persona needs a nonempty 'name' and 'system_prompt'")
        extra = _check_persona(p, f"persona {p['name']!r}")
        unknown = [t for t in extra["tools"] if t not in names]
        if unknown:
            raise ValueError(f"persona {p['name']!r} uses unknown integrations: {', '.join(unknown)}")
        clean = [c for c in clean if c["name"] != p["name"].strip()]
        clean.append({"name": p["name"].strip(), "system_prompt": p["system_prompt"], **extra})
    cfg["personas"] = clean

    cfg.setdefault("host", "0.0.0.0")
    cfg.setdefault("markdown", True)
    cfg.setdefault("show_stats", False)
    cfg.setdefault("show_reasoning", True)
    cfg.setdefault("fix_encoding", True)
    cfg.setdefault("https", False)
    token = cfg.get("token")
    if token is not None and not isinstance(token, str):
        raise ValueError("token must be a string or null")
    cfg["token_from_env"] = "LM_API_TOKEN" in os.environ
    cfg["token"] = os.environ.get("LM_API_TOKEN", token or "")
    if cfg.get("password_hash") is not None and not isinstance(cfg["password_hash"], str):
        raise ValueError("password_hash must be a string or null (use --set-password)")
    return cfg


def save_config(**changes):
    """Update only the given keys in config.json, keeping every other key."""
    with _config_lock:
        with CONFIG_PATH.open(encoding="utf-8") as f:
            data = json.load(f)
        data.update(changes)
        tmp = CONFIG_PATH.with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, CONFIG_PATH)


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


def check_url(url):
    if not isinstance(url, str) or not url.strip():
        raise ValueError("The LM Studio URL can't be empty.")
    url = url.strip()
    if "://" not in url:
        url = "http://" + url
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("The LM Studio URL must look like http://<lmstudio-host>:1234")
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


def repair(text):
    return fix_mojibake(text) if CFG.get("fix_encoding", True) else text


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
    return {"name": name, "kind": "text", "size": size, "content": repair(content), "encoding": encoding}


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
    return repair("\n\n".join(pages))


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


def _items(result, kind):
    return [i for i in result.get("output", []) if isinstance(i, dict) and i.get("type") == kind]


def extract_answer(result):
    return "\n\n".join(i["content"] for i in _items(result, "message") if isinstance(i.get("content"), str)).strip()


def extract_reasoning(result):
    return "\n\n".join(i["content"] for i in _items(result, "reasoning") if isinstance(i.get("content"), str)).strip()


def _clip(value):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
    text = repair(text)
    return text if len(text) <= TOOL_OUTPUT_LIMIT else text[:TOOL_OUTPUT_LIMIT] + f"\n… [{len(text):,} chars, truncated]"


def _provider(info):
    if not isinstance(info, dict):
        return ""
    return info.get("plugin_id") or info.get("server_label") or ""


def extract_tools(result):
    tools = []
    for item in result.get("output", []):
        if not isinstance(item, dict):
            continue
        if item.get("type") == "tool_call":
            tools.append({"tool": item.get("tool"), "provider": _provider(item.get("provider_info")),
                          "arguments": _clip(item.get("arguments", {})), "output": _clip(item.get("output", "")),
                          "ok": True})
        elif item.get("type") == "invalid_tool_call":
            meta = item.get("metadata") or {}
            tools.append({"tool": meta.get("tool_name"), "provider": _provider(meta.get("provider_info")),
                          "arguments": _clip(meta.get("arguments", {})), "output": repair(str(item.get("reason", ""))),
                          "ok": False})
    return tools


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
                elif event == "tool_call.start":
                    yield ndjson({"type": "tool", "phase": "start", "tool": data.get("tool"),
                                  "provider": _provider(data.get("provider_info"))})
                elif event == "tool_call.arguments":
                    yield ndjson({"type": "tool", "phase": "arguments", "tool": data.get("tool"),
                                  "arguments": _clip(data.get("arguments", {}))})
                elif event == "tool_call.success":
                    yield ndjson({"type": "tool", "phase": "success", "tool": data.get("tool"),
                                  "arguments": _clip(data.get("arguments", {})), "output": _clip(data.get("output", ""))})
                elif event == "tool_call.failure":
                    meta = data.get("metadata") or {}
                    yield ndjson({"type": "tool", "phase": "failure", "tool": meta.get("tool_name") or data.get("tool"),
                                  "output": repair(str(data.get("reason", "")))})
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
        yield ndjson({"type": "fatal", "message": f"Cannot reach LM Studio at {urlsplit(CFG['url']).netloc}: {exc}"})
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
        "tools": extract_tools(final),
        "response_id": new_id if isinstance(new_id, str) and new_id.startswith("resp_") else None,
        "stats": {**stats, "elapsed_seconds": round(time.monotonic() - started, 2)},
        "model_instance_id": final.get("model_instance_id"),
    })


# --------------------------------------------------------------------------- security headers

@app.after_request
def security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("Permissions-Policy", "microphone=(self), camera=(), geolocation=()")
    # Everything is served from this server: no third-party scripts, fonts or styles.
    resp.headers.setdefault("Content-Security-Policy",
                            "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
                            "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; "
                            "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    if request.path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-store")
    return resp


# --------------------------------------------------------------------------- routes

@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/config")
def public_config():
    """Everything the UI needs — never the token, password hash or integration headers."""
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
        "integrations": [{"name": x["name"], "default": x["default"], "description": x["description"],
                          "kind": x["spec"]["type"]} for x in CFG["integrations"]],
        "token_set": bool(CFG["token"]),
        "token_hint": token_hint(CFG["token"]),
        "token_from_env": CFG["token_from_env"],
        "max_file_bytes": CFG["max_file_bytes"],
        "max_image_bytes": CFG["max_image_bytes"],
        "max_pdf_bytes": CFG["max_pdf_bytes"],
        "tts": TTS.status(),
        "stt": STT.status(),
        "https": bool(CFG.get("_https_active")),
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
        reasoning = caps.get("reasoning") if isinstance(caps.get("reasoning"), dict) else {}
        options = [o for o in reasoning.get("allowed_options") or [] if o in REASONING_LEVELS]
        models.append({
            "key": m["key"],
            "name": m.get("display_name") or m["key"],
            "loaded": bool(m.get("loaded_instances")),
            "vision": bool(caps.get("vision")),
            "tools": bool(caps.get("trained_for_tool_use")),
            "params": m.get("params_string"),
            "context_length": context_length(m),
            "reasoning_options": options,
            "reasoning_default": reasoning.get("default") if reasoning.get("default") in REASONING_LEVELS else None,
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
    store = body.get("store") is not False
    payload = {"model": model, "input": compose_input(message.strip(), attachments), "store": store, "stream": True}
    previous_id = body.get("previous_response_id")
    if isinstance(previous_id, str) and previous_id.startswith("resp_"):
        payload["previous_response_id"] = previous_id
    else:
        previous_id = None
        system_prompt = body.get("system_prompt")
        payload["system_prompt"] = system_prompt if isinstance(system_prompt, str) and system_prompt.strip() \
            else CFG["system_prompt"]
    temperature = body.get("temperature", CFG.get("temperature"))
    if _num(temperature, 0, 1):
        payload["temperature"] = temperature
    max_out = body.get("max_output_tokens", CFG.get("max_output_tokens"))
    if _num(max_out, 1, integer=True):
        payload["max_output_tokens"] = max_out
    if body.get("reasoning") in REASONING_LEVELS:
        payload["reasoning"] = body["reasoning"]
    wanted = body.get("tools") if isinstance(body.get("tools"), list) else []
    specs = [x["spec"] for x in CFG["integrations"] if x["name"] in wanted]
    if specs:
        payload["integrations"] = specs
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
        save_config(url=url, token=token)
    except (OSError, ValueError) as exc:
        return jsonify({"error": f"Could not write {CONFIG_PATH.name}: {exc}"}), 500
    CFG["url"], CFG["token"] = url, token
    note = ""
    if CFG["token_from_env"]:
        note = "Saved. Note: the LM_API_TOKEN environment variable is set and will override this token next time the server starts."
    return jsonify({"ok": True, "url": url, "server": urlsplit(url).netloc,
                    "token_set": bool(token), "token_hint": token_hint(token), "note": note})


@app.post("/api/tts")
def tts():
    if not TTS.available:
        return jsonify({"error": TTS.error or "Kokoro TTS is not installed on the server."}), 501
    body = request.get_json(silent=True) or {}
    text = body.get("text") if isinstance(body.get("text"), str) else ""
    text = text.strip()[:1200]
    if not text:
        return jsonify({"error": "No text."}), 400
    voices = body.get("voices") if isinstance(body.get("voices"), dict) else None
    try:
        wav, lang, voice = TTS.synthesize(text, voices=voices, hint=body.get("hint") or "pt", speed=body.get("speed"))
    except Exception as exc:
        return jsonify({"error": f"TTS failed: {exc.__class__.__name__}: {exc}"}), 500
    return Response(wav, mimetype="audio/wav", headers={"X-TTS-Lang": lang, "X-TTS-Voice": voice})


@app.post("/api/stt")
def stt():
    if not STT.available:
        return jsonify({"error": STT.error or "faster-whisper is not installed on the server."}), 501
    f = request.files.get("audio")
    if not f:
        return jsonify({"error": "No audio received."}), 400
    raw = f.read(CFG["max_audio_bytes"] + 1)
    if len(raw) > CFG["max_audio_bytes"]:
        return jsonify({"error": "Recording too long."}), 413
    language = request.form.get("language") or None
    try:
        text, lang = STT.transcribe(raw, language=language)
    except Exception as exc:
        return jsonify({"error": f"Transcription failed: {exc.__class__.__name__}: {exc}"}), 500
    return jsonify({"text": repair(text), "language": lang})


@app.errorhandler(413)
def too_large(_):
    return jsonify({"error": "Upload too large."}), 413


# --------------------------------------------------------------------------- main

def set_password_cli():
    print("Set the password for the LOCAL//GRID web interface.")
    while True:
        p1 = getpass.getpass("New password: ")
        if len(p1) < auth.MIN_PASSWORD:
            print(f"Use at least {auth.MIN_PASSWORD} characters.")
            continue
        if getpass.getpass("Repeat it: ") != p1:
            print("The two passwords differ, try again.")
            continue
        save_config(password_hash=auth.hash_password(p1))
        print(f"Saved (as a scrypt hash) in {CONFIG_PATH.name}. All devices will need to log in again.")
        return 0


def serve(host, port, cert=None, key=None):
    try:
        from cheroot import wsgi
    except ImportError:
        print("cheroot is not installed; using Flask's development server (pip install cheroot).")
        app.run(host=host, port=port, threaded=True, debug=False,
                ssl_context=(str(cert), str(key)) if cert else None)
        return
    server = wsgi.Server((host, port), app, numthreads=24, server_name="localgrid", timeout=300)
    if cert:
        from cheroot.ssl.builtin import BuiltinSSLAdapter
        server.ssl_adapter = BuiltinSSLAdapter(str(cert), str(key))
    try:
        server.start()
    except KeyboardInterrupt:
        server.stop()


def main():
    global CFG, CONFIG_PATH, TTS, STT
    parser = argparse.ArgumentParser(description="LOCAL//GRID — LM Studio web chat")
    parser.add_argument("--config", type=Path, default=ROOT / "config.json")
    parser.add_argument("--host", help="override config host (default 0.0.0.0 = whole network)")
    parser.add_argument("--port", type=int, help="override config port")
    parser.add_argument("--https", action="store_true", help="serve over HTTPS (needed for voice input)")
    parser.add_argument("--set-password", action="store_true", help="set the login password and exit")
    args = parser.parse_args()
    CONFIG_PATH = args.config.resolve()
    example = ROOT / "config.example.json"
    if not CONFIG_PATH.exists() and example.exists() and CONFIG_PATH.name == "config.json":
        import shutil
        shutil.copyfile(example, CONFIG_PATH)   # your settings, token and password hash live here (git-ignored)
        print(f"Created {CONFIG_PATH.name} from config.example.json.")
    if args.set_password:
        return set_password_cli()
    try:
        CFG = load_config(CONFIG_PATH)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 1

    https = bool(args.https or CFG.get("https"))
    cert = key = None
    if https:
        if CFG.get("ssl_cert") and CFG.get("ssl_key"):
            cert, key = Path(CFG["ssl_cert"]).expanduser(), Path(CFG["ssl_key"]).expanduser()
        else:
            from certs import ensure_self_signed
            try:
                cert, key = ensure_self_signed(CONFIG_PATH.parent / "certs")
            except RuntimeError as exc:
                print(exc, file=sys.stderr)
                return 1
    CFG["_https_active"] = https

    app.config["MAX_CONTENT_LENGTH"] = max(CFG["max_pdf_bytes"], CFG["max_image_bytes"]) * 3 + 8 * 1024 * 1024
    auth.init(app, CFG, save_config, CONFIG_PATH.parent / ".secret_key", https)

    TTS = KokoroTTS(CFG.get("tts"))
    STT = WhisperSTT(CFG.get("stt"))
    for engine, label in ((TTS, "Kokoro TTS"), (STT, "faster-whisper")):
        if engine.enabled and engine.installed:
            print(f"{label}: loading in the background (the first run downloads the model).")
            threading.Thread(target=engine.warm_up, daemon=True).start()
        elif engine.enabled:
            print(f"{label}: not installed — optional (see README).")

    host = args.host or CFG["host"]
    port = args.port or CFG["port"]
    scheme = "https" if https else "http"
    print(f"LM Studio: {CFG['url']}  ·  model: {CFG['model']}")
    if not CFG.get("password_hash"):
        print(f"No password yet: open {scheme}://localhost:{port} on THIS machine to create one, "
              "or run: python app.py --set-password")
    print(f"Open {scheme}://<this-machine-ip>:{port} from any device on your network (Ctrl+C to stop).")
    serve(host, port, cert, key)
    return 0


if __name__ == "__main__":
    sys.exit(main())
