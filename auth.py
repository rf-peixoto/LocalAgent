"""Single-user password login.

- The password is stored only as a salted scrypt hash (`password_hash` in config.json).
- Sessions are signed cookies (HttpOnly, SameSite=Strict, Secure under HTTPS).
- Changing the password logs out every device (the session carries a hash fingerprint).
- Failed logins are rate-limited per IP address.
- With no password set yet, the password can only be created from the server machine
  itself (or with `python app.py --set-password`), so nobody else on the network can claim it.
"""
import hashlib
import os
import secrets
import threading
import time
from datetime import timedelta
from pathlib import Path

from flask import Blueprint, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

bp = Blueprint("auth", __name__)
MIN_PASSWORD = 8
_ctx = {"cfg": None, "save": None}
_failures = {}          # ip -> [count, locked_until]
_lock = threading.Lock()
PUBLIC_ENDPOINTS = {"auth.login_page", "auth.login", "auth.setup", "static"}


def init(app, cfg, save_config, secret_path: Path, https: bool):
    """cfg: live config dict; save_config(**changes) persists keys to config.json."""
    _ctx["cfg"], _ctx["save"] = cfg, save_config
    app.secret_key = _load_secret(secret_path)
    app.config.update(SESSION_COOKIE_NAME="localgrid_session", SESSION_COOKIE_HTTPONLY=True,
                      SESSION_COOKIE_SAMESITE="Strict", SESSION_COOKIE_SECURE=https,
                      PERMANENT_SESSION_LIFETIME=timedelta(days=30))
    app.register_blueprint(bp)
    app.before_request(_guard)


def _load_secret(path: Path):
    try:
        data = path.read_bytes()
        if len(data) >= 32:
            return data
    except OSError:
        pass
    data = secrets.token_bytes(48)
    path.write_bytes(data)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return data


def hash_password(password):
    return generate_password_hash(password, method="scrypt")


def _fingerprint():
    h = _ctx["cfg"].get("password_hash") or ""
    return hashlib.sha256(h.encode()).hexdigest()[:20]


def password_set():
    return bool(_ctx["cfg"].get("password_hash"))


def is_local_request():
    return request.remote_addr in ("127.0.0.1", "::1", "::ffff:127.0.0.1")


def is_authenticated():
    return password_set() and session.get("auth") is True and session.get("pv") == _fingerprint()


def _guard():
    if request.endpoint in PUBLIC_ENDPOINTS:
        return None
    if is_authenticated():
        return None
    if request.path.startswith("/api/"):
        return jsonify({"error": "Login required.", "login": True}), 401
    return redirect(url_for("auth.login_page"))


def _client_key():
    return request.remote_addr or "?"


def _check_lock():
    with _lock:
        count, until = _failures.get(_client_key(), [0, 0])
        wait = until - time.monotonic()
    return max(0, int(wait + 0.999))


def _register_failure():
    with _lock:
        entry = _failures.setdefault(_client_key(), [0, 0])
        entry[0] += 1
        if entry[0] >= 5:   # 5 free attempts, then 30s, 60s, 120s ... up to 15 min
            entry[1] = time.monotonic() + min(900, 30 * 2 ** (entry[0] - 5))
        if len(_failures) > 10000:
            _failures.clear()


def _start_session(remember):
    session.clear()
    session["auth"] = True
    session["pv"] = _fingerprint()
    session.permanent = bool(remember)


# --------------------------------------------------------------------------- routes

@bp.get("/login")
def login_page():
    if is_authenticated():
        return redirect(url_for("index"))
    mode = "login" if password_set() else ("setup" if is_local_request() else "blocked")
    return render_template("login.html", mode=mode, min_len=MIN_PASSWORD)


@bp.post("/api/login")
def login():
    if not password_set():
        return jsonify({"error": "No password has been set yet."}), 400
    wait = _check_lock()
    if wait:
        return jsonify({"error": f"Too many attempts. Try again in {wait}s."}), 429
    body = request.get_json(silent=True) or {}
    password = body.get("password") if isinstance(body.get("password"), str) else ""
    if not check_password_hash(_ctx["cfg"]["password_hash"], password):
        _register_failure()
        time.sleep(0.4)
        wait = _check_lock()
        return jsonify({"error": "Wrong password." + (f" Locked for {wait}s." if wait else "")}), 401
    with _lock:
        _failures.pop(_client_key(), None)
    _start_session(body.get("remember"))
    return jsonify({"ok": True})


@bp.post("/api/setup")
def setup():
    """First-run password creation — only from the server machine itself."""
    if password_set():
        return jsonify({"error": "A password is already set."}), 400
    if not is_local_request():
        return jsonify({"error": "Create the password on the server machine (http://localhost) "
                                 "or run: python app.py --set-password"}), 403
    body = request.get_json(silent=True) or {}
    password = body.get("password") if isinstance(body.get("password"), str) else ""
    if len(password) < MIN_PASSWORD:
        return jsonify({"error": f"Use at least {MIN_PASSWORD} characters."}), 400
    h = hash_password(password)
    _ctx["save"](password_hash=h)
    _ctx["cfg"]["password_hash"] = h
    _start_session(True)
    return jsonify({"ok": True})


@bp.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@bp.post("/api/password")
def change_password():
    body = request.get_json(silent=True) or {}
    current, new = body.get("current"), body.get("new")
    if not isinstance(current, str) or not isinstance(new, str):
        return jsonify({"error": "Missing fields."}), 400
    wait = _check_lock()
    if wait:
        return jsonify({"error": f"Too many attempts. Try again in {wait}s."}), 429
    if not check_password_hash(_ctx["cfg"]["password_hash"], current):
        _register_failure()
        return jsonify({"error": "The current password is wrong."}), 403
    if len(new) < MIN_PASSWORD:
        return jsonify({"error": f"Use at least {MIN_PASSWORD} characters."}), 400
    h = hash_password(new)
    _ctx["save"](password_hash=h)
    _ctx["cfg"]["password_hash"] = h
    _start_session(session.permanent)   # this device stays logged in; all others are logged out
    return jsonify({"ok": True})
