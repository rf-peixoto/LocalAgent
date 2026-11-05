# LOCAL//GRID — LM Studio Web Chat

A password-protected browser interface for LM Studio's native `POST /api/v1/chat` endpoint, with a neon cyberpunk look.

```
your browser  ──►  LOCAL//GRID (app.py, any machine)  ──►  LM Studio (<lmstudio-host>:1234)
```

The Flask app serves the page and relays each message to LM Studio, so you can chat from any device on your network. The LM Studio token stays on the server and is never sent to the browser. The page loads nothing from the internet: fonts and libraries are bundled.

## Install and run

```bash
python -m pip install -r requirements.txt
python app.py --set-password          # once: create the login password
python app.py
```

The first run creates `config.json` from `config.example.json`. Your settings, LM Studio token and password hash live in `config.json`, which `.gitignore` keeps out of version control; commit changes you want to share to `config.example.json` instead.

Open `http://<ip-of-this-machine>:5000` from any device on your network. If it doesn't load from another device, allow port 5000 in this machine's firewall.

- **Password.** Instead of `--set-password`, you can open `http://localhost:5000` on this machine: it offers to create the password. Other devices see a locked screen until a password exists, so nobody else on the network can claim it.
- **Options.** `--port 8080` uses another port, `--host 127.0.0.1` makes the page reachable only from this machine, and `--config other.json` uses another configuration file.
- **Server.** It runs on **cheroot**, a production-grade Python server, and falls back to Flask's built-in server if cheroot isn't installed.

## Login

- A single password protects the whole interface, including Settings. It's stored only as a salted scrypt hash in `config.json`.
- "Keep me logged in" lasts 30 days; otherwise the session ends when you close the browser.
- After 5 wrong attempts, logins from that address are locked for 30 seconds, then 60, and so on, up to 15 minutes.
- ⚙ Settings → Account changes the password and logs out every other device. ⏻ in the sidebar logs out this device.
- Forgot the password? Run `python app.py --set-password` on the server.
- Session cookies are `HttpOnly` and `SameSite=Strict`, and `Secure` under HTTPS. Pages are sent with a strict Content-Security-Policy.

## HTTPS (needed for voice input)

Browsers allow the microphone only on HTTPS pages, or on the machine itself.

```bash
python app.py --https
```

The first start creates a self-signed certificate in `certs/` for this machine's name and addresses. Each device then shows a certificate warning once; accept it to continue. If this machine's IP address changes, delete `certs/` so the certificate is regenerated.

For no warnings at all, create a certificate with [mkcert](https://github.com/FiloSottile/mkcert), install its local authority on your devices, and set `"https": true`, `"ssl_cert"` and `"ssl_key"` in `config.json`.

## Connection to LM Studio

In ⚙ Settings → **Connection to LM Studio**:

- **Server URL**: `lmstudio-host:1234` is enough; the `/api/v1/chat` path is added for you.
- **API token**: the token LM Studio asks for when "Require authentication" is on. Leave the field blank to keep the current one, or tick **No token**.
- **Test connection** checks the settings before you save them.

The URL and token are saved in `config.json` on the server. Settings only ever shows the token's last 4 characters. The `LM_API_TOKEN` environment variable, if set, overrides the token when the server starts.

## Voice (optional, fully local)

```bash
python -m pip install -r requirements-voice.txt
```

**Read aloud — Kokoro-82M.**
- Replies are spoken sentence by sentence, with the next sentence prepared while the current one plays.
- Each sentence is detected as Portuguese or English and gets the matching voice. An English word inside a Portuguese sentence keeps a Portuguese accent.
- Portuguese voices: `pf_dora`, `pm_alex`, `pm_santa`. English voices: `af_heart` and others.
- Portuguese needs the **espeak-ng** program: `sudo apt install espeak-ng` on Linux, `brew install espeak-ng` on macOS, or the installer from the espeak-ng releases page on Windows.
- It runs fine on a CPU. The first start downloads the model (about 330 MB) from Hugging Face; after that it works offline.
- If Kokoro isn't installed, or a request fails, the browser's own voice is used instead.

**Voice input — faster-whisper.**
- The 🎙 button (or Ctrl+M) records; press it again to transcribe. The text is inserted at the cursor so you can review it before sending. Esc cancels.
- Needs HTTPS (see above). The first start downloads the Whisper model: `small` by default, about 460 MB.
- `medium` is more accurate for Portuguese but slower on a CPU.

Voices, speed, test playback and the input language are in ⚙ Settings → Voice. To turn either feature off, set `"enabled": false` in the `tts` or `stt` section of `config.json`.

## Personas

Pick one on the new-chat screen. Each persona can set more than a prompt:

```json
{
  "name": "Coder",
  "system_prompt": "...",
  "temperature": 0.2,
  "model": "qwen2.5-coder-32b-instruct",
  "reasoning": "off",
  "tools": ["Web search"]
}
```

- `model` is a model key exactly as LM Studio shows it; the model picker shows the keys.
- `reasoning` is one of `off`, `low`, `medium`, `high` or `on`. It's applied only when the model supports that level.
- `tools` lists names from `integrations`.

All three are optional. ⚙ Settings → "Save as persona…" also stores the current chat's model, reasoning and tools, in this browser only.

## Reasoning control

For models that report reasoning options (such as Qwen3), a 🧠 picker appears next to the model. **Auto** uses the model's own default. **Off** skips the thinking phase for quick answers, and higher levels think longer. The choice is saved per chat.

## Tools (MCP)

LM Studio can let the model call tools from MCP servers. Declare the ones you want in `config.json`:

```json
"integrations": [
  { "name": "Browser", "id": "mcp/playwright", "description": "From LM Studio's mcp.json" },
  { "name": "Hugging Face", "server_url": "https://huggingface.co/mcp", "server_label": "huggingface",
    "allowed_tools": ["model_search"], "headers": { "Authorization": "Bearer ..." }, "default": false }
]
```

- **`id`** refers to a server already configured in LM Studio's `mcp.json`. LM Studio needs **Server settings → "Allow calling servers from mcp.json"**.
- **`server_url`** defines the server per request. LM Studio needs **"Allow per-request MCPs"**. `headers` stay on the server and are never sent to the browser.
- **Choosing tools.** Pick a chat's tools from the **TOOLS** menu in the header. `"default": true` turns a tool on for new chats.
- **In the chat.** Each tool call appears in the reply with its arguments and output.

## Long chats: Summarize & continue

When the **CTX** meter passes 75%, a banner offers **Summarize & continue**; it's also always in the ⋮ menu.

- The model writes a compact summary of the chat. That request isn't stored as part of the old chat.
- A new chat opens with the same persona, model, reasoning and tools, with the summary attached to your first message.

## Accents and broken characters

LM Studio streams replies without declaring a charset. The app always decodes them as UTF-8, and repairs text that arrives already broken ("NÃ£o" → "Não"). Uploaded text files in Windows-1252 or UTF-16 are converted automatically. To turn the repair off, use ⚙ Settings → "Fix broken accents" or set `"fix_encoding": false`.

## Everything else

- **Chatting.**
  - Regenerate, edit and resend earlier messages (or press <kbd>↑</kbd> in the empty box to edit the last one), and Continue.
  - Stop with Esc.
  - Read aloud.
  - A live phase, timer and speed while generating.
- **Code.** Blocks are syntax-colored, with Wrap, Copy and Download buttons and a renameable file name. Each answer's code downloads as a .zip, and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> copies the last block.
- **Files.** Attach with ⊕, by dropping or by pasting:
  - text and source files
  - PNG, JPEG, WEBP and GIF images (the model must support vision)
  - PDFs (the text is extracted)
- **Chats.**
  - Stored only in each browser, with a draft kept per chat.
  - Pin, search (<kbd>Ctrl</kbd>+<kbd>K</kbd>), rename, duplicate, delete.
  - Export as .md or .json; ⇩ Backup and ⇪ Import move chats between machines.
- **Storage.** ⚙ Settings → Storage shows how much space chats use and removes stored images: those older than 7 days, or all of them. The chats themselves are kept.
- **Look.** Four text sizes, and a "Visual effects" switch for the scanlines and glitch. <kbd>Ctrl</kbd>+<kbd>/</kbd> lists all shortcuts.

## config.json reference

| Key | Meaning |
|---|---|
| `url`, `token` | LM Studio endpoint and API token. Easier to set in ⚙ Settings. |
| `model` | Default model. |
| `system_prompt` | Prompt of the built-in "Default" persona. |
| `personas` | Presets; see above. |
| `integrations` | MCP tools; see above. |
| `temperature`, `max_output_tokens` | `null` means the model's default and no limit. |
| `connect_timeout`, `response_timeout` | Seconds; `null` disables the idle timeout. |
| `max_file_bytes`, `max_image_bytes`, `max_pdf_bytes`, `max_audio_bytes` | Upload limits. |
| `markdown`, `show_stats`, `show_reasoning`, `fix_encoding` | Defaults for the toggles in ⚙ Settings. |
| `tts` | `enabled`, `voice_pt`, `voice_en`, `speed`, `device` (`null` picks automatically). |
| `stt` | `enabled`, `model` (`tiny` … `large-v3`), `device` (`cpu`/`cuda`), `compute_type`, `language` (`null` = detect). |
| `password_hash` | Set by `--set-password`; don't edit by hand. |
| `host`, `port`, `https`, `ssl_cert`, `ssl_key` | Where and how the server listens. |

## When LM Studio restarts

LM Studio keeps each conversation's context on its side, and a saved chat continues from the ID of its last reply. After a restart, LM Studio may no longer recognize that ID. The chat then shows **Resend with saved history**, which starts a new session from the saved transcript; image attachments are left out.

## Files

| Path | Purpose |
|---|---|
| `app.py` | Server: configuration, relay to LM Studio, uploads, voice endpoints |
| `auth.py` | Login, sessions, rate limiting |
| `voice.py` | Kokoro TTS and faster-whisper STT (optional) |
| `certs.py` | Self-signed certificate for `--https` |
| `textfix.py` | UTF-8 repair and text-file decoding |
| `static/`, `templates/` | The web interface; `static/vendor/` holds the bundled libraries and fonts, with their licenses |
| `config.example.json` | Template for `config.json` (copied on first run) |
| `config.json`, `.secret_key`, `certs/` | Created at runtime. They hold secrets and are git-ignored. |
