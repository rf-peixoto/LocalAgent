# LOCAL//GRID — LM Studio Web Chat

A browser interface for LM Studio's native `POST /api/v1/chat` endpoint, with a neon cyberpunk look.

```
your browser  ──►  Flask (app.py, any machine)  ──►  LM Studio (Your local IP:1234)
```

Flask serves the page and relays each message to LM Studio, so you can chat from any device on your network. The API token stays in `config.json` on the Flask machine and is never sent to the browser.

## Run

```bash
python -m pip install -r requirements.txt
python app.py
```

Then open `http://<ip-of-the-machine-running-app.py>:5000` in any browser on your network. If the page doesn't load from another device, allow port 5000 in that machine's firewall.

## Connection and API token

In ⚙ Settings → **Connection to LM Studio**:

- **Server URL**: `Your local IP:1234` is enough; the `/api/v1/chat` path is added for you.
- **API token**: the token LM Studio asks for when its "Require authentication" option is on. Leave the field blank to keep the current token, or tick **No token** if authentication is off.
- **Test connection** checks the settings before you save them, and tells you if the server can't be reached or rejects the token.

The URL and token are saved in `config.json` on the server, so every device shares them. The token never travels back to the browser; Settings only shows its last 4 characters. The `LM_API_TOKEN` environment variable, if set, still overrides the token when the server starts.

To use different settings, run `python app.py --config other.json --port 8080`. `--host 127.0.0.1` makes the page reachable only from the machine running it.

## Accents and broken characters ("NÃ£o" instead of "Não")

**Cause.** LM Studio streams its replies as `text/event-stream` without declaring a charset. In that case Python's `requests` library assumes ISO-8859-1, so every accented character breaks before it ever reaches the screen. The terminal version, `chat.py`, has the same bug.

**Fixes in this app:**

1. The stream is read as raw bytes and decoded as UTF-8 line by line, so text is no longer broken in transit.
2. A repair step converts text that arrives already broken back to normal characters, for example when the model itself outputs garbled text. It handles both Latin-1 and Windows-1252 garbling, and text broken twice. It accepts a repair only when the result is a plausible character, so correct text such as "Até…”" is never altered.
3. Chats saved by the previous version are repaired automatically the first time the page opens.
4. Uploaded text files saved as Windows-1252 (common with Windows editors) or UTF-16 are converted to UTF-8 automatically, instead of being rejected.

To turn the repair off, use ⚙ Settings → "Fix broken accents", or set `"fix_encoding": false` in `config.json`.

One case can't be fixed: if a reply already contains the `�` replacement symbol, the original bytes were thrown away before the text reached this app.

## config.json

| Key | Meaning |
|---|---|
| `url` | LM Studio chat endpoint. The model list is read from the same server's `/api/v1/models`. |
| `model` | Default model. You can switch models per chat from the dropdown at the top. |
| `token` | LM Studio API token; `""` means no token. Easier to set in ⚙ Settings. `LM_API_TOKEN` overrides it. |
| `system_prompt` | System prompt of the built-in "Default" persona. |
| `personas` | Extra presets, each with `name`, `system_prompt` and optional `temperature`. They appear as buttons on the new-chat screen. Edits take effect for new chats after the server restarts and the page reloads. |
| `temperature` | `null` uses the model's default. Otherwise a number from 0 to 1. |
| `max_output_tokens` | `null` means no limit. |
| `connect_timeout` / `response_timeout` | Same as the terminal version. `null` disables the idle timeout. |
| `max_file_bytes` | Size limit for a text file, and for the text extracted from a PDF. |
| `max_image_bytes` / `max_pdf_bytes` | Upload limits for images and PDFs. |
| `markdown`, `show_stats`, `show_reasoning`, `fix_encoding` | Defaults for the toggles in ⚙ Settings. |
| `host`, `port` | Where Flask listens. `0.0.0.0` means the whole network. |

## Features

**Chatting**
- Personas: pick one on the new-chat screen. They come from `config.json`: Default, Coder, Threat Intel, Red Team, Blue Team / DFIR, Reverse Engineer, Data Analyst and Report Writer. You can also save your own in ⚙ Settings → "Save as persona…"; those are stored in this browser.
- Settings can be changed while a reply is generating. A new system prompt then applies from your next new chat.
- **↻ Regenerate** asks for a new answer to your last message.
- **Edit** (or <kbd>↑</kbd> in the empty input box) rewrites an earlier message. Sending replaces that message and everything after it. LM Studio continues from the matching point in the conversation, so no context is wasted.
- **Continue** asks the model to keep going when an answer stops early.
- **Read aloud** reads an answer with the browser's built-in text-to-speech; code blocks are skipped.
- **Stop** with the Stop button or Esc. A stopped or failed reply isn't saved and doesn't advance the conversation. Your message and files go back into the input box, and nothing is retried automatically.
- While a reply is generating, you see its phase (loading the model, reading the prompt, thinking, writing), the elapsed time and an estimated speed.
- The **CTX** meter in the header shows how much of the model's context window the chat uses. It turns amber, then red, as it fills up; that's the moment to start a new chat.
- If the reply finishes while the tab is in the background, the tab title shows "● Reply ready".

**Code**
- Code blocks are syntax-colored. Each has buttons to **Wrap** long lines, **Copy**, and **Download**. Click the file name in the block's header to rename it before downloading.
- <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> copies the last code block.
- Each answer can download its code files as a .zip. The ⋮ menu downloads all the code in a chat.

**Files**
- Attach with ⊕, by dropping files anywhere on the page, or by pasting (for example, a screenshot).
- Supported: text and source files (UTF-8, Windows-1252 or UTF-16); PNG, JPEG, WEBP and GIF images (the model must support vision; the chip turns amber if the selected model doesn't report it); and PDFs (the text is extracted page by page).
- Click an attachment chip in an old message to download it again.

**Chats**
- History is saved in the browser's own storage, so each machine sees only its own chats. Unsent text is kept per chat as a draft.
- Pin chats to the top, search all chats with <kbd>Ctrl</kbd>+<kbd>K</kbd>, and use the ⋮ menu to rename, duplicate or delete a chat.
- Export a chat as .md or .json, or copy it as Markdown.
- **⇩ Backup** downloads every chat in one file. **⇪ Import** accepts a single chat or a whole backup; use the pair to move chats to another machine.

**Look**
- Text size has four steps in ⚙ Settings. "Visual effects" switches off the scanlines, glow and glitch animation.
- Animations are also off automatically if the system is set to reduce motion.
- <kbd>Ctrl</kbd>+<kbd>/</kbd> lists all keyboard shortcuts.

## When LM Studio restarts

LM Studio keeps each conversation's context on its side. A saved chat continues by sending LM Studio the ID of the last reply (`previous_response_id`). After LM Studio restarts it may no longer recognize that ID. When that happens, the chat shows a **Resend with saved history** button. It starts a new LM Studio session with the saved transcript (including text and PDF attachments; images are left out) followed by your message.

## Notes

- Copy works over plain `http://` on your network through a fallback, because browsers only allow the modern clipboard API on HTTPS or localhost.
- The page loads its fonts and three small libraries from public CDNs: marked, DOMPurify and highlight.js. The browser therefore needs internet access, but the model traffic stays on your network.
- Model output is sanitized before display, and downloaded code is never executed.
- This is Flask's built-in server, which is fine for one user on a home network. Don't expose it to the internet; there is no login.
