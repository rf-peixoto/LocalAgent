/* LOCAL//GRID — browser side of the LM Studio web chat.
 * Conversations live in this browser's IndexedDB (each machine sees only its own chats).
 * Flask relays requests to LM Studio and keeps the API token server-side.
 */
"use strict";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
  return n;
};

/* ======================================================================= state */
let CONFIG = null;
let PREFS = null;            // user preferences (localStorage), seeded from config.json
let MODELS = [];             // from LM Studio
let conversations = [];      // sorted by updated desc
let current = null;          // active conversation object
let pending = [];            // queued attachments for the next message
let busy = null;             // { controller } while generating
let editing = null;          // { index } when editing/regenerating from a past message

const LANG_EXT = {
  python: ".py", py: ".py", javascript: ".js", js: ".js", jsx: ".jsx", typescript: ".ts", ts: ".ts", tsx: ".tsx",
  bash: ".sh", sh: ".sh", shell: ".sh", zsh: ".sh", console: ".sh", powershell: ".ps1", ps1: ".ps1", bat: ".bat", cmd: ".bat",
  c: ".c", cpp: ".cpp", "c++": ".cpp", h: ".h", hpp: ".hpp", csharp: ".cs", cs: ".cs", rust: ".rs", rs: ".rs", go: ".go",
  java: ".java", kotlin: ".kt", swift: ".swift", scala: ".scala", lua: ".lua", r: ".r", julia: ".jl", perl: ".pl",
  html: ".html", css: ".css", scss: ".scss", json: ".json", yaml: ".yaml", yml: ".yml", toml: ".toml", ini: ".ini",
  xml: ".xml", sql: ".sql", ruby: ".rb", rb: ".rb", php: ".php", dockerfile: "Dockerfile", makefile: "Makefile",
  text: ".txt", plaintext: ".txt", txt: ".txt", markdown: ".md", md: ".md", csv: ".csv", diff: ".diff", vue: ".vue",
  svelte: ".svelte", tex: ".tex", latex: ".tex", vb: ".vb", vba: ".bas", matlab: ".m", dart: ".dart", elixir: ".ex",
};

function codeFilename(lang, index) {
  const key = (lang || "").trim().split(/\s+/)[0].toLowerCase() || "text";
  const ext = LANG_EXT[key] || ".txt";
  if (!ext.startsWith(".")) return index > 1 ? `${ext}_${index}` : ext;
  return `code_${index}${ext}`;
}

/* ======================================================================= encoding repair
 * Same algorithm as fix_mojibake() in app.py. Used for text streamed live, and to repair
 * chats saved before the server-side fix.                                               */
const BYTE_OF = (() => {
  const m = new Map();
  const cp1252 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F" +
                 "\u0090‘’“”•–—˜™š›œ\u009DžŸ";
  for (let b = 0x80; b < 0x100; b++) m.set(String.fromCharCode(b), b);
  for (let i = 0; i < 32; i++) m.set(cp1252[i], 0x80 + i);
  return m;
})();
const MOJI_HINT = /[Â-ô][\u0080-¿ŒœŠšŸŽžƒˆ˜–—‘-‚“-„†-•…‰‹›€™]/;
const PLAUSIBLE = [[0x80, 0x17F], [0x300, 0x36F], [0x370, 0x3FF], [0x400, 0x4FF], [0x1E00, 0x1EFF], [0x2000, 0x206F],
  [0x20A0, 0x20CF], [0x2100, 0x27BF], [0x2900, 0x2BFF], [0xFE00, 0xFE0F], [0x1F000, 0x1FAFF]];
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Len = b => (b >= 0xC2 && b <= 0xDF ? 2 : b >= 0xE0 && b <= 0xEF ? 3 : b >= 0xF0 && b <= 0xF4 ? 4 : 0);

function fixMojibake(text) {
  if (typeof text !== "string" || !MOJI_HINT.test(text)) return text;
  text = text.replaceAll("â€�", "”");
  for (let pass = 0; pass < 3; pass++) {
    const chars = [...text];
    const out = [];
    let changed = false;
    for (let i = 0; i < chars.length;) {
      const lead = BYTE_OF.get(chars[i]);
      const size = lead === undefined ? 0 : utf8Len(lead);
      if (size && i + size <= chars.length) {
        const seq = [lead];
        for (let j = 1; j < size; j++) {
          const b = BYTE_OF.get(chars[i + j]);
          if (b === undefined || b < 0x80 || b > 0xBF) break;
          seq.push(b);
        }
        if (seq.length === size) {
          let decoded = null;
          try { decoded = utf8Decoder.decode(new Uint8Array(seq)); } catch { decoded = null; }
          const cp = decoded ? decoded.codePointAt(0) : -1;
          if (decoded && PLAUSIBLE.some(([lo, hi]) => cp >= lo && cp <= hi)) {
            out.push(decoded); i += size; changed = true; continue;
          }
        }
      }
      out.push(chars[i]); i++;
    }
    if (!changed) break;
    text = out.join("");
  }
  return text;
}
const fix = t => (PREFS?.fix_encoding === false ? t : fixMojibake(t));

/* ======================================================================= utils */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function fmtBytes(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; }
function fmtK(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n); }
function fmtTime(ts) { if (!ts) return ""; const d = new Date(ts); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function safeName(s, fallback) { return (s || "").replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 80) || fallback; }
const isTouch = () => matchMedia("(pointer: coarse)").matches;

let toastTimer;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), isErr ? 5000 : 1800);
}

/** Clipboard API only exists on HTTPS/localhost; LAN http:// needs the textarea fallback. */
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  const ta = el("textarea", { style: "position:fixed;top:-1000px;opacity:0", readonly: true });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}

async function copyWithFeedback(text, button, label) {
  label = label || button?.textContent || "Copy";
  const ok = await copyText(text);
  if (button) {
    button.textContent = ok ? "Copied ✓" : "Copy failed";
    button.classList.toggle("done", ok);
    setTimeout(() => { button.textContent = label; button.classList.remove("done"); }, 1500);
  } else toast(ok ? "Copied" : "Copy failed", !ok);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const downloadText = (text, filename, type = "text/plain") =>
  downloadBlob(new Blob([text], { type: type + ";charset=utf-8" }), filename);

async function downloadZip(files, zipName) {
  if (!files.length) return toast("No code blocks found.", true);
  try {
    const r = await fetch("/api/zip", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files, zip_name: zipName }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    downloadBlob(await r.blob(), zipName);
  } catch (e) { toast(`Zip failed: ${e.message}`, true); }
}

/** Fenced code blocks from raw Markdown → [{lang, code}] (same rule as the terminal version). */
function extractCode(markdown) {
  const out = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(markdown || ""))) out.push({ lang: m[1].trim(), code: m[2] });
  return out;
}
const codeFiles = blocks => blocks.map((b, i) => ({ name: codeFilename(b.lang, i + 1), content: b.code }));

/* ======================================================================= storage (IndexedDB) */
const DB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("local-llm-chat", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("conversations", { keyPath: "id" });
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  store(mode) { return this.db.transaction("conversations", mode).objectStore("conversations"); },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  all() { return this.req(this.store("readonly").getAll()); },
  put(c) { return this.req(this.store("readwrite").put(c)); },
  del(id) { return this.req(this.store("readwrite").delete(id)); },
};

function loadPrefs() {
  const defaults = {
    persona: "Default", system_prompt: CONFIG.system_prompt, temperature: CONFIG.temperature,
    max_output_tokens: CONFIG.max_output_tokens, model: CONFIG.model,
    markdown: CONFIG.markdown, show_stats: CONFIG.show_stats, show_reasoning: CONFIG.show_reasoning,
    fix_encoding: CONFIG.fix_encoding, enter_sends: true, effects: true, font_size: "m", user_personas: [],
    tts_engine: "kokoro", tts_speed: CONFIG.tts?.speed || 1, voice_pt: CONFIG.tts?.defaults?.pt || "pf_dora",
    voice_en: CONFIG.tts?.defaults?.en || "af_heart", stt_lang: "",
  };
  try { PREFS = { ...defaults, ...JSON.parse(localStorage.getItem("llmchat-prefs") || "{}") }; }
  catch { PREFS = defaults; }
}
function savePrefs() { try { localStorage.setItem("llmchat-prefs", JSON.stringify(PREFS)); } catch { /* private mode */ } }
function applyLook() {
  document.documentElement.dataset.font = PREFS.font_size;
  document.documentElement.classList.toggle("fx", !!PREFS.effects);
}

function allPersonas() {
  const list = (CONFIG.personas || []).map(p => ({ ...p, builtin: true }));
  for (const p of PREFS.user_personas || []) {
    const i = list.findIndex(x => x.name === p.name);
    if (i >= 0) list[i] = { ...p, builtin: false }; else list.push({ ...p, builtin: false });
  }
  return list;
}

/** The persona new chats start with. Named personas always use their current definition
 *  (so editing config.json takes effect); "Custom" uses the prompt saved in this browser. */
function activePersona() {
  const list = allPersonas();
  if (PREFS.persona === "Custom") return { name: "Custom", system_prompt: PREFS.system_prompt, temperature: PREFS.temperature, tools: defaultTools() };
  return list.find(p => p.name === PREFS.persona) || list.find(p => p.name === "Default") || list[0];
}

function defaultTools() { return (CONFIG.integrations || []).filter(x => x.default).map(x => x.name); }
function knownTools(list) { const names = new Set((CONFIG.integrations || []).map(x => x.name)); return (list || []).filter(n => names.has(n)); }

function newConversation() {
  const p = activePersona();
  return { id: uid(), title: "New chat", created: Date.now(), updated: Date.now(), pinned: false, draft: "",
    model: p.model || PREFS.model || CONFIG.model, persona: p.name, system_prompt: p.system_prompt,
    temperature: p.temperature ?? null, max_output_tokens: PREFS.max_output_tokens,
    reasoning: p.reasoning ?? null, tools: p.tools?.length ? knownTools(p.tools) : defaultTools(),
    previous_response_id: null, messages: [] };
}

async function persist(conv, { touch = true } = {}) {
  if (touch) conv.updated = Date.now();
  try { await DB.put(conv); } catch (e) { toast(`Could not save chat locally: ${e.message}`, true); }
  if (!conversations.includes(conv)) conversations = [conv, ...conversations.filter(c => c.id !== conv.id)];
  conversations.sort((a, b) => b.updated - a.updated);
  renderSidebar();
}

/** One-time repair of chats saved while the stream was decoded with the wrong charset. */
async function repairStoredChats() {
  if (!PREFS.fix_encoding) return;
  let repaired = 0;
  for (const c of conversations) {
    let changed = false;
    const f = s => { const r = fixMojibake(s); if (r !== s) changed = true; return r; };
    c.title = f(c.title);
    for (const m of c.messages) {
      m.content = f(m.content);
      if (m.reasoning) m.reasoning = f(m.reasoning);
      for (const a of m.attachments || []) if (a.kind !== "image" && a.content) a.content = f(a.content);
    }
    if (changed) { repaired++; await DB.put(c).catch(() => {}); }
  }
  if (repaired) toast(`Repaired broken characters in ${repaired} saved chat${repaired > 1 ? "s" : ""}`);
}

/* ======================================================================= markdown rendering */
marked.setOptions({ gfm: true, breaks: false });

function renderMarkdownInto(node, text, { streaming = false, startIndex = 1 } = {}) {
  if (!PREFS.markdown) {
    node.classList.add("plain");
    node.textContent = text;
    return;
  }
  node.classList.remove("plain");
  node.innerHTML = DOMPurify.sanitize(marked.parse(text || ""));
  node.querySelectorAll("a").forEach(a => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
  let index = startIndex;
  node.querySelectorAll("pre > code").forEach(code => decorateCode(code, index++, streaming));
}

function decorateCode(code, index, streaming) {
  const pre = code.parentElement;
  const langClass = [...code.classList].find(c => c.startsWith("language-"));
  const lang = langClass ? langClass.slice(9) : "";
  const raw = code.textContent;
  if (lang && hljs.getLanguage(lang)) {
    try { code.innerHTML = hljs.highlight(raw, { language: lang, ignoreIllegals: true }).value; code.classList.add("hljs"); } catch { /* plain */ }
  } else if (!streaming && raw.length < 20000) {
    try { const r = hljs.highlightAuto(raw); if (r.relevance > 5) { code.innerHTML = r.value; code.classList.add("hljs"); } } catch { /* plain */ }
  }
  const lines = raw.replace(/\n$/, "").split("\n").length;
  const fname = el("input", { class: "fname", value: codeFilename(lang, index), spellcheck: "false",
    title: "File name used by Download (click to edit)", "aria-label": "File name" });
  const wrapBtn = el("button", { type: "button", text: "Wrap", title: "Toggle line wrapping" });
  wrapBtn.onclick = () => { const on = pre.classList.toggle("wrap"); wrapBtn.classList.toggle("on", on); };
  const copyBtn = el("button", { type: "button", text: "Copy", class: "accent" });
  copyBtn.onclick = () => copyWithFeedback(raw, copyBtn, "Copy");
  const dlBtn = el("button", { type: "button", text: "Download" });
  dlBtn.onclick = () => downloadText(raw, safeName(fname.value, codeFilename(lang, index)));
  const head = el("div", { class: "code-head" },
    el("span", { class: "lang", text: lang || "text" }), el("span", { class: "lines", text: `${lines} line${lines > 1 ? "s" : ""}` }),
    fname, wrapBtn, copyBtn, dlBtn);
  const block = el("div", { class: "code-block" });
  pre.replaceWith(block);
  block.append(head, pre);
}

/* ======================================================================= rendering: messages */
const messagesEl = () => $("#messages");
function nearBottom() { const m = messagesEl(); return m.scrollHeight - m.scrollTop - m.clientHeight < 140; }
function scrollBottom(force = false) { const m = messagesEl(); if (force || nearBottom()) m.scrollTop = m.scrollHeight; updateScrollBtn(); }
function updateScrollBtn() { $("#scrollDown").hidden = nearBottom(); }

function attachmentChip(a, { removable = false, onRemove } = {}) {
  const extra = a.encoding && a.encoding !== "UTF-8" ? ` · decoded as ${a.encoding}` : "";
  const chip = el("span", { class: "chip", title: `${a.name} · ${a.kind}${a.size ? " · " + fmtBytes(a.size) : ""}${extra}` });
  if (a.kind === "image" && a.content) chip.append(el("img", { src: a.content, alt: "" }));
  if (a.kind === "image" && !a.content) { chip.classList.add("removed"); chip.title += " · image removed from this browser"; }
  chip.append(el("span", { class: "k", text: a.kind === "image" ? "img" : a.kind }), el("span", { class: "n", text: a.name }));
  if (extra) chip.append(el("span", { class: "k enc", text: a.encoding }));
  if (removable) chip.append(el("button", { class: "x", type: "button", title: "Remove", text: "×", onclick: onRemove }));
  else if (a.content) {
    chip.classList.add("click");
    chip.title += " · click to download";
    chip.onclick = () => {
      if (a.kind === "image") fetch(a.content).then(r => r.blob()).then(b => downloadBlob(b, a.name));
      else downloadText(a.content, a.kind === "pdf" ? a.name.replace(/\.pdf$/i, "") + ".txt" : a.name);
    };
  }
  return chip;
}

function actionBtn(text, onclick, title) { return el("button", { type: "button", text, title, onclick }); }

function renderUserTurn(msg, index) {
  const wrap = el("div", { class: "user-wrap" });
  wrap.append(el("div", { class: "role user-role" }, el("span", { text: "> you" }), el("span", { class: "ts", text: fmtTime(msg.ts) })));
  if (msg.attachments?.length) wrap.append(el("div", { class: "chips" }, msg.attachments.map(a => attachmentChip(a))));
  if (msg.content) wrap.append(el("div", { class: "msg user", text: msg.content }));
  const bar = el("div", { class: "msg-actions" });
  const copyBtn = actionBtn("Copy", () => copyWithFeedback(msg.content, copyBtn, "Copy"));
  bar.append(copyBtn);
  if (index != null) bar.append(actionBtn("Edit", () => startEdit(index), "Edit this message and resend it (replaces everything after it)"));
  wrap.append(bar);
  return wrap;
}

function statsText(s) {
  if (!s) return "";
  const parts = [];
  if (typeof s.elapsed_seconds === "number") parts.push(`${s.elapsed_seconds.toFixed(1)}s`);
  if (typeof s.input_tokens === "number") parts.push(`${s.input_tokens} in`);
  if (typeof s.total_output_tokens === "number") parts.push(`${s.total_output_tokens} out`);
  if (typeof s.tokens_per_second === "number") parts.push(`${s.tokens_per_second.toFixed(1)} tok/s`);
  if (typeof s.time_to_first_token_seconds === "number") parts.push(`TTFT ${s.time_to_first_token_seconds.toFixed(2)}s`);
  return parts.join(" · ");
}

function speakable(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, "\n(code block)\n").replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "(link)")
    .replace(/^\s*\|?[-:| ]+\|[-:| ]*$/gm, "")          // table separator rows
    .replace(/\|/g, ", ")
    .replace(/^#+\s*/gm, "").replace(/^\s*[-*+]\s+/gm, "").replace(/[*_~>#]{1,3}/g, "")
    .replace(/[ \t]+/g, " ").trim();
}

/** Sentence-ish chunks of ~60-240 characters (Kokoro sounds best in that range). */
function splitForTTS(text) {
  const parts = text.split(/(?<=[.!?…:;])\s+|\n+/).map(x => x.trim()).filter(Boolean);
  const out = [];
  let cur = "";
  for (let part of parts) {
    while (part.length > 300) {                       // very long sentence: break at a comma or space
      let cut = part.lastIndexOf(", ", 240); if (cut < 80) cut = part.lastIndexOf(" ", 240); if (cut < 80) cut = 240;
      out.push(part.slice(0, cut + 1).trim()); part = part.slice(cut + 1).trim();
    }
    if (cur && (cur.length + part.length > 240)) { out.push(cur); cur = part; }
    else cur = cur ? cur + " " + part : part;
    if (cur.length >= 60 && /[.!?…]$/.test(cur)) { out.push(cur); cur = ""; }
  }
  if (cur) out.push(cur);
  return out;
}

/** Read aloud: Kokoro on the server when available (sentence by sentence, next one prefetched
 *  while the current plays), otherwise the browser's built-in voice. */
const Speaker = {
  btn: null, label: "", ctrl: null, audio: null, resolvePlay: null,
  setButton(btn) {
    if (this.btn) { this.btn.textContent = this.label; this.btn.classList.remove("on"); }
    this.btn = btn;
    if (btn) { this.label = btn.textContent; btn.textContent = "■ Stop reading"; btn.classList.add("on"); }
  },
  stop() {
    this.ctrl?.abort(); this.ctrl = null;
    if (this.audio) { this.audio.pause(); this.audio = null; }
    if (this.resolvePlay) { this.resolvePlay(); this.resolvePlay = null; }
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    this.setButton(null);
  },
  toggle(text, btn, override = {}) {
    const same = this.btn === btn;
    this.stop();
    if (same) return;
    this.setButton(btn);
    const o = { engine: PREFS.tts_engine, speed: PREFS.tts_speed || 1, voices: { pt: PREFS.voice_pt, en: PREFS.voice_en }, ...override };
    const useKokoro = o.engine === "kokoro" && CONFIG.tts?.available;
    (useKokoro ? this.kokoro(text, o) : this.browser(text, o)).catch(e => {
      if (e.name === "AbortError") return;
      toast(`Kokoro: ${e.message} — using the browser voice.`, true);
      if (this.btn === btn) this.browser(text, o);
    });
  },
  browser(text, o) {
    return new Promise(resolve => {
      if (!("speechSynthesis" in window)) { toast("Read aloud isn't supported in this browser.", true); this.setButton(null); return resolve(); }
      const btn = this.btn;
      const u = new SpeechSynthesisUtterance(speakable(text));
      u.lang = navigator.language || "pt-BR";
      u.rate = o.speed;
      u.onend = u.onerror = () => { if (this.btn === btn) this.setButton(null); resolve(); };
      speechSynthesis.speak(u);
    });
  },
  async kokoro(text, o) {
    const btn = this.btn;
    const segs = splitForTTS(speakable(text));
    if (!segs.length) { this.setButton(null); return; }
    const ctrl = this.ctrl = new AbortController();
    let hint = /[ãõçéá]/i.test(text) ? "pt" : "en";
    const fetchSeg = async seg => {
      const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal,
        body: JSON.stringify({ text: seg, hint, speed: o.speed, voices: o.voices }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      hint = r.headers.get("X-TTS-Lang") || hint;
      return URL.createObjectURL(await r.blob());
    };
    let next = fetchSeg(segs[0]);
    for (let i = 0; i < segs.length; i++) {
      const url = await next;
      if (ctrl.signal.aborted) { URL.revokeObjectURL(url); return; }
      if (i + 1 < segs.length) { next = fetchSeg(segs[i + 1]); next.catch(() => {}); }
      await this.play(url);
      if (ctrl.signal.aborted) return;
    }
    if (this.btn === btn) this.setButton(null);
  },
  play(url) {
    return new Promise((resolve, reject) => {
      const a = new Audio(url);
      this.audio = a;
      this.resolvePlay = resolve;
      a.onended = () => { URL.revokeObjectURL(url); this.resolvePlay = null; resolve(); };
      a.onerror = () => { URL.revokeObjectURL(url); reject(new Error("audio playback failed")); };
      a.play().catch(reject);
    });
  },
};
function toggleSpeak(text, btn) { Speaker.toggle(text, btn); }

/** Voice input: record in the browser, transcribe with faster-whisper on the server. */
const Mic = {
  rec: null, stream: null, chunks: [], timer: null, t0: 0, cancelled: false,
  get active() { return this.rec?.state === "recording"; },
  async toggle() { if (this.active) this.stop(); else await this.start(); },
  async start() {
    if (busy) return toast("Wait for the reply to finish.", true);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
      return toast("Voice input needs HTTPS — start the server with --https (see README).", true);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) { return toast(`Microphone not available: ${e.message}`, true); }
    const mime = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find(m => window.MediaRecorder?.isTypeSupported?.(m)) || "";
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : {});
    this.chunks = []; this.cancelled = false;
    this.rec.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.onstop = () => this.finish();
    this.rec.start(250);
    this.t0 = Date.now();
    $("#micBtn").classList.add("rec");
    const tick = () => {
      const s = Math.floor((Date.now() - this.t0) / 1000);
      setStatus(`● REC ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} — 🎙 or Ctrl+M to stop · Esc to cancel`);
      if (s >= 180) this.stop();
    };
    tick();
    this.timer = setInterval(tick, 500);
  },
  stop(cancel = false) {
    if (!this.rec) return;
    this.cancelled = cancel;
    if (this.rec.state !== "inactive") this.rec.stop();
    this.stream?.getTracks().forEach(t => t.stop());
  },
  async finish() {
    clearInterval(this.timer);
    $("#micBtn").classList.remove("rec");
    const type = this.rec?.mimeType || "audio/webm";
    this.rec = null;
    if (this.cancelled) { setStatus(""); return; }
    const blob = new Blob(this.chunks, { type });
    if (blob.size < 2000) { setStatus(""); return toast("Nothing was recorded.", true); }
    setStatus("Transcribing…");
    const form = new FormData();
    form.append("audio", blob, "voice." + (type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : "webm"));
    if (PREFS.stt_lang) form.append("language", PREFS.stt_lang);
    try {
      const r = await fetch("/api/stt", { method: "POST", body: form });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      if (!data.text) return toast("No speech recognized.", true);
      const input = $("#input");
      const before = input.value.slice(0, input.selectionStart), after = input.value.slice(input.selectionEnd);
      const sep = before && !/\s$/.test(before) ? " " : "";
      input.value = before + sep + data.text + (after && !/^\s/.test(after) ? " " : "") + after;
      const pos = (before + sep + data.text).length;
      input.setSelectionRange(pos, pos);
      input.dispatchEvent(new Event("input"));
      input.focus();
    } catch (e) { toast(`Transcription failed: ${e.message}`, true); }
    finally { setStatus(""); }
  },
};

function assistantActions(msg, turnIndex, isLast) {
  const bar = el("div", { class: "msg-actions" });
  const copyBtn = actionBtn("Copy", () => copyWithFeedback(msg.content, copyBtn, "Copy"));
  bar.append(copyBtn, actionBtn("Download .md", () => downloadText(msg.content, `answer_${turnIndex}.md`, "text/markdown")));
  const blocks = extractCode(msg.content);
  if (blocks.length > 1) bar.append(actionBtn(`Download ${blocks.length} code files (.zip)`, () => downloadZip(codeFiles(blocks), `code_answer_${turnIndex}.zip`)));
  const speakBtn = actionBtn("Read aloud", () => toggleSpeak(msg.content, speakBtn));
  bar.append(speakBtn);
  if (isLast) bar.append(actionBtn("↻ Regenerate", regenerate, "Ask again for a new answer to the last message"),
    actionBtn("Continue", () => quickSend("Continue exactly where you stopped."), "Ask the model to keep going"));
  if (PREFS.show_stats && msg.stats) bar.append(el("span", { class: "stats", text: statsText(msg.stats) }));
  return bar;
}

function thinkingBlock(text, open = false) {
  const d = el("details", { class: "thinking" }, el("summary", { text: "Thinking" }), el("div", { class: "think-body", text }));
  if (open) d.open = true;
  return d;
}

function renderAssistantTurn(msg, turnIndex, isLast) {
  const wrap = el("div");
  wrap.append(el("div", { class: "role" }, el("span", { text: "// " + (msg.model || "assistant") }), el("span", { class: "ts", text: fmtTime(msg.ts) })));
  if (PREFS.show_reasoning && msg.reasoning) wrap.append(thinkingBlock(msg.reasoning));
  if (msg.tools?.length) wrap.append(toolsBlock(msg.tools));
  const body = el("div", { class: "msg assistant" });
  renderMarkdownInto(body, msg.content);
  wrap.append(body, assistantActions(msg, turnIndex, isLast));
  return wrap;
}

function renderConversation() {
  const box = messagesEl();
  const stick = nearBottom();
  // While a reply is streaming, its turns are kept (and moved back to the end) so that
  // re-rendering — e.g. after saving settings — never detaches the live reply.
  const live = busy ? $$(".turn.live", box) : [];
  $$(".turn", box).forEach(n => { if (!live.includes(n)) n.remove(); });
  $("#empty").hidden = current.messages.length > 0 || live.length > 0;
  renderPersonaPicker();
  let turnIndex = 0;
  const lastAsst = current.messages.map(m => m.role).lastIndexOf("assistant");
  current.messages.forEach((msg, i) => {
    const turn = el("div", { class: "turn", "data-idx": i });
    if (editing && i >= editing.index) { if (busy) turn.hidden = true; else turn.classList.add("superseded"); }
    if (msg.role === "user") { turnIndex++; turn.append(renderUserTurn(msg, i)); }
    else turn.append(renderAssistantTurn(msg, turnIndex, i === lastAsst && i === current.messages.length - 1));
    box.append(turn);
  });
  live.forEach(n => box.append(n));
  $("#chatTitle").textContent = current.title;
  $("#personaBadge").textContent = current.persona && current.persona !== "Default" ? current.persona : "";
  $("#personaBadge").hidden = !$("#personaBadge").textContent;
  syncModelSelect();
  updateContextMeter();
  scrollBottom(!busy || stick);
}

function renderPersonaPicker() {
  let note = $("#contNote");
  if (!note) { note = el("p", { id: "contNote", class: "cont-note" }); $("#personaPicker").before(note); }
  const from = current.continued_from && conversations.find(c => c.id === current.continued_from);
  note.hidden = !from;
  if (from) note.textContent = `Continuing from “${from.title}” — its summary is attached below.`;
  const box = $("#personaPicker");
  box.innerHTML = "";
  const list = allPersonas();
  if (list.length < 2) return;
  for (const p of list) {
    const extras = [p.model ? `model: ${p.model}` : "", p.reasoning ? `reasoning: ${p.reasoning}` : "",
      p.tools?.length ? `tools: ${p.tools.join(", ")}` : ""].filter(Boolean).join(" · ");
    const b = el("button", { type: "button", class: "persona" + (p.name === current.persona ? " on" : ""),
      title: (extras ? extras + "\n\n" : "") + p.system_prompt.slice(0, 300), text: p.name });
    b.onclick = () => { usePersona(p); renderPersonaPicker(); $("#input").focus(); };
    box.append(b);
  }
}

function usePersona(p) {
  PREFS.persona = p.name; PREFS.system_prompt = p.system_prompt; PREFS.temperature = p.temperature ?? null;
  savePrefs();
  if (current.messages.length) { startNewChat(); toast(`New chat · ${p.name}`); return; }
  Object.assign(current, { persona: p.name, system_prompt: p.system_prompt, temperature: p.temperature ?? null,
    reasoning: p.reasoning ?? null, tools: p.tools?.length ? knownTools(p.tools) : defaultTools() });
  if (p.model) current.model = p.model;
  renderConversation();
}

/* ======================================================================= context meter */
function updateContextMeter() {
  const meter = $("#ctxMeter");
  const info = currentModelInfo();
  const last = [...current.messages].reverse().find(m => m.role === "assistant" && m.stats);
  const max = info?.context_length;
  if (!max || !last) { meter.hidden = true; $("#ctxBanner").hidden = true; return; }
  const used = (last.stats.input_tokens || 0) + (last.stats.total_output_tokens || 0);
  const pct = Math.min(100, (used / max) * 100);
  meter.hidden = false;
  meter.querySelector(".ctx-text").textContent = `CTX ${fmtK(used)}/${fmtK(max)}`;
  meter.querySelector(".ctx-fill").style.width = pct + "%";
  meter.classList.toggle("warn", pct >= 75);
  meter.classList.toggle("full", pct >= 92);
  meter.title = `About ${used.toLocaleString()} of ${max.toLocaleString()} context tokens used` +
    (pct >= 75 ? ". Near the limit the model starts forgetting the beginning — use Summarize & continue." : "");
  $("#ctxPct").textContent = Math.round(pct);
  $("#ctxBanner").hidden = pct < 75 || !!current.ctx_dismissed || !!busy || !!editing;
}

/* ======================================================================= sidebar */
function renderSidebar() {
  const list = $("#convList");
  const q = $("#search").value.trim().toLowerCase();
  list.innerHTML = "";
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups = [["Today", startToday], ["Last 7 days", startToday - 6 * 864e5], ["Last 30 days", startToday - 29 * 864e5], ["Older", -Infinity]];
  const visible = conversations.filter(c => c.messages.length && (!q || c.title.toLowerCase().includes(q) ||
    c.messages.some(m => (m.content || "").toLowerCase().includes(q))));
  if (!visible.length) list.append(el("div", { class: "conv-group", text: q ? "No matches" : "No chats yet" }));
  const ordered = [...visible.filter(c => c.pinned), ...visible.filter(c => !c.pinned)];
  let lastGroup = null;
  for (const c of ordered) {
    const g = c.pinned ? "Pinned" : groups.find(([, t]) => c.updated >= t)[0];
    if (g !== lastGroup) { list.append(el("div", { class: "conv-group", text: g })); lastGroup = g; }
    const item = el("div", { class: "conv" + (current && c.id === current.id ? " active" : ""), title: c.title });
    item.append(
      el("span", { class: "t", text: c.title }),
      el("button", { class: "pin" + (c.pinned ? " on" : ""), title: c.pinned ? "Unpin" : "Pin to top", text: "⌖",
        onclick: async e => { e.stopPropagation(); c.pinned = !c.pinned; await persist(c, { touch: false }); } }),
      el("button", { class: "del", title: "Delete chat", text: "✕", onclick: e => { e.stopPropagation(); deleteConversation(c); } }));
    item.onclick = () => { openConversation(c); closeSidebar(); };
    list.append(item);
  }
}

function leaveCurrent() {
  if (current) current.draft = $("#input").value;
  if (current?.messages.length) persist(current, { touch: false });
  cancelEdit(false);
}

function openConversation(c) {
  if (busy) return toast("Wait for the reply to finish (or press Stop).", true);
  if (c === current) return;
  leaveCurrent();
  current = c;
  $("#input").value = c.draft || "";
  autosize();
  renderConversation();
  renderSidebar();
  history.replaceState(null, "", "#" + c.id);
  if (!isTouch()) $("#input").focus();
}

async function deleteConversation(c) {
  if (busy && c === current) return toast("Stop the reply first.", true);
  if (!confirm(`Delete "${c.title}"? This cannot be undone.`)) return;
  await DB.del(c.id).catch(() => {});
  conversations = conversations.filter(x => x.id !== c.id);
  if (current && current.id === c.id) { current = null; startNewChat(); }
  else renderSidebar();
}

function startNewChat() {
  if (busy) return toast("Wait for the reply to finish (or press Stop).", true);
  if (current) leaveCurrent();
  current = newConversation();
  $("#input").value = "";
  autosize();
  renderConversation();
  renderSidebar();
  history.replaceState(null, "", location.pathname);
  if (!isTouch()) $("#input").focus();
}

function closeSidebar() { $("#app").classList.remove("side-open"); }

/* ======================================================================= models */
async function loadModels() {
  const dot = $("#serverDot");
  try {
    const r = await fetch("/api/models");
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    MODELS = data.models || [];
    dot.className = "dot ok";
    dot.title = `LM Studio online at ${CONFIG.server} · ${MODELS.length} models`;
    $("#linkInfo").textContent = `LINK ${CONFIG.server} · ONLINE`;
  } catch (e) {
    MODELS = [];
    dot.className = "dot bad";
    dot.title = `LM Studio not reachable at ${CONFIG.server}: ${e.message}`;
    $("#linkInfo").textContent = `LINK ${CONFIG.server} · OFFLINE`;
  }
  syncModelSelect();
  updateContextMeter();
}

function syncModelSelect() {
  const sel = $("#modelSelect");
  const want = current?.model || PREFS.model || CONFIG.model;
  const keys = new Set(MODELS.map(m => m.key));
  sel.innerHTML = "";
  const list = [...MODELS];
  if (!keys.has(want)) list.unshift({ key: want, name: want });
  for (const m of list) {
    const flags = [m.loaded ? "● loaded" : "", m.vision ? "vision" : "", m.params || "",
      m.context_length ? fmtK(m.context_length) + " ctx" : ""].filter(Boolean).join(" · ");
    sel.append(el("option", { value: m.key, text: m.name + (flags ? `  (${flags})` : "") }));
  }
  sel.value = want;
  syncReasoningSelect();
  renderToolsMenu();
}

function modelInfo(key) { return MODELS.find(m => m.key === key); }
function currentModelInfo() { return modelInfo(current?.model || CONFIG.model); }

/** Reasoning effort picker — only shown for models that report reasoning options. */
function syncReasoningSelect() {
  const sel = $("#reasoningSelect");
  const info = currentModelInfo();
  const opts = info?.reasoning_options || [];
  if (!opts.length) { sel.hidden = true; return; }
  sel.hidden = false;
  sel.innerHTML = "";
  sel.append(el("option", { value: "", text: `🧠 auto${info.reasoning_default ? ` (${info.reasoning_default})` : ""}` }));
  for (const o of opts) sel.append(el("option", { value: o, text: `🧠 ${o}` }));
  sel.value = opts.includes(current?.reasoning) ? current.reasoning : "";
}

/** Tools (MCP integrations from config.json) the model may use in this chat. */
function renderToolsMenu() {
  const list = CONFIG.integrations || [];
  $("#toolsWrap").hidden = !list.length;
  if (!list.length || !current) return;
  const on = new Set(current.tools || []);
  const menu = $("#toolsMenu");
  menu.replaceChildren(el("div", { class: "menu-head", text: "Tools for this chat" }));
  for (const t of list) {
    const cb = el("input", { type: "checkbox" });
    cb.checked = on.has(t.name);
    cb.onchange = async () => {
      const set = new Set(current.tools || []);
      cb.checked ? set.add(t.name) : set.delete(t.name);
      current.tools = list.map(x => x.name).filter(n => set.has(n));
      if (current.messages.length) await persist(current, { touch: false });
      renderToolsMenu();
    };
    menu.append(el("label", { class: "tool-opt", title: t.description || "" }, cb, el("span", { text: t.name }),
      el("span", { class: "k", text: t.kind === "plugin" ? "mcp.json" : "url" })));
  }
  const info = currentModelInfo();
  if (info && !info.tools) menu.append(el("div", { class: "menu-note warn", text: "This model isn't marked as trained for tool use — results may be poor." }));
  menu.append(el("div", { class: "menu-note", text: "LM Studio must allow it: Server settings → “Allow calling servers from mcp.json” (and “Allow per-request MCPs” for URL tools)." }));
  const n = on.size;
  $("#toolsCount").textContent = n;
  $("#toolsBtn").classList.toggle("on", n > 0);
}

/* ======================================================================= attachments */
async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const form = new FormData();
  files.forEach((f, i) => form.append("files", f, f.name || `pasted_${i + 1}.png`));
  setStatus(`Reading ${files.length} file(s)…`);
  try {
    const r = await fetch("/api/upload", { method: "POST", body: form });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    for (const item of data.items) pending.push(item);
    for (const err of data.errors) toast(err, true);
    const odd = data.items.filter(i => i.encoding && i.encoding !== "UTF-8");
    if (odd.length) toast(`${odd.map(i => `${i.name} (${i.encoding})`).join(", ")} converted to UTF-8`);
    else if (data.items.length) toast(`Attached ${data.items.map(i => i.name).join(", ")}`);
  } catch (e) { toast(`Upload failed: ${e.message}`, true); }
  setStatus("");
  renderPending();
}

function renderPending() {
  const box = $("#attachments");
  box.innerHTML = "";
  const info = currentModelInfo();
  pending.forEach((a, i) => {
    const chip = attachmentChip(a, { removable: true, onRemove: () => { pending.splice(i, 1); renderPending(); } });
    if (a.kind === "image" && info && !info.vision) { chip.classList.add("warn"); chip.title += " · this model may not support images"; }
    box.append(chip);
  });
}

/* ======================================================================= editing / regenerate */
function startEdit(index) {
  if (busy) return;
  const msg = current.messages[index];
  if (!msg || msg.role !== "user") return;
  editing = { index };
  $("#input").value = msg.content;
  pending = (msg.attachments || []).map(a => ({ ...a }));
  renderPending();
  autosize();
  $("#editBanner").hidden = false;
  $("#editBanner .what").textContent = `Editing message ${current.messages.slice(0, index + 1).filter(m => m.role === "user").length}`;
  renderConversation();
  const turn = $(`.turn[data-idx="${index}"]`);
  if (turn) turn.scrollIntoView({ block: "center" });
  $("#input").focus();
}

function cancelEdit(rerender = true) {
  if (!editing) return;
  editing = null;
  $("#editBanner").hidden = true;
  if (rerender) { $("#input").value = ""; pending = []; renderPending(); autosize(); renderConversation(); }
}

function regenerate() {
  if (busy) return;
  const msgs = current.messages;
  const i = msgs.length - 2;
  if (i < 0 || msgs[i].role !== "user") return;
  editing = { index: i };
  $("#editBanner").hidden = false;
  $("#editBanner .what").textContent = "Regenerating the last answer";
  send({ text: msgs[i].content, attachments: (msgs[i].attachments || []).map(a => ({ ...a })) });
}

function quickSend(text) {
  if (busy) return;
  send({ text, attachments: [] });
}

/* ======================================================================= sending */
function setStatus(text) { $("#statusLine").textContent = text || ""; }
function setBusy(on) {
  const b = $("#sendBtn");
  b.querySelector("span").textContent = on ? "Stop" : "Send";
  b.classList.toggle("stop", on);
  b.title = on ? "Stop generating (Esc)" : "Send";
  document.body.classList.toggle("busy", on);
}

function transcriptForRebuild(history) {
  const lines = [];
  for (const m of history) {
    const files = (m.attachments || []).filter(a => a.kind !== "image")
      .map(a => `<file name=${JSON.stringify(a.name)}>\n${a.content}\n</file>`).join("\n");
    const images = (m.attachments || []).filter(a => a.kind === "image").map(a => `[image: ${a.name}]`).join(" ");
    lines.push(`### ${m.role === "user" ? "User" : "Assistant"}\n${[files, images, m.content].filter(Boolean).join("\n")}`);
  }
  return "The following is our earlier conversation, restored from local history. Continue from it.\n\n" + lines.join("\n\n");
}

let titleBeforeAlert = null;
function alertIfHidden() {
  if (!document.hidden) return;
  if (titleBeforeAlert == null) titleBeforeAlert = document.title;
  document.title = "● Reply ready — " + titleBeforeAlert;
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && titleBeforeAlert != null) { document.title = titleBeforeAlert; titleBeforeAlert = null; }
});

/* ======================================================================= live reply (streaming UI) */

function toolItem(t) {
  const state = t.running ? "running…" : t.ok === false ? "failed" : "done";
  const d = el("details", { class: "tool " + (t.running ? "run" : t.ok === false ? "bad" : "ok") },
    el("summary", {}, el("span", { class: "tname", text: "⚙ " + (t.tool || "tool") }),
      t.provider ? el("span", { class: "tprov", text: t.provider }) : null, el("span", { class: "tstate", text: state })));
  if (t.arguments) d.append(el("div", { class: "tlabel", text: "arguments" }), el("pre", { class: "tpre", text: t.arguments }));
  if (t.output) d.append(el("div", { class: "tlabel", text: t.ok === false ? "error" : "output" }), el("pre", { class: "tpre", text: t.output }));
  return d;
}
function toolsBlock(tools) { return el("div", { class: "tools" }, tools.map(toolItem)); }

/** The assistant turn while a reply streams in. Only the unfinished tail of the Markdown is
 *  re-rendered on each update; completed paragraphs/blocks are rendered once and kept. */
class LiveReply {
  constructor(label) {
    this.turn = el("div", { class: "turn live" });
    this.thinkBody = el("div", { class: "think-body" });
    this.thinking = el("details", { class: "thinking", hidden: true }, el("summary", { text: "Thinking…" }), this.thinkBody);
    this.thinking.open = true;
    this.toolsBox = el("div", { class: "tools", hidden: true });
    this.body = el("div", { class: "msg assistant cursor" });
    this.stable = el("div", { class: "md-part" });
    this.tail = el("div", { class: "md-part" });
    this.body.append(this.stable, this.tail);
    this.chip = el("div", { class: "status-chip" }, el("span", { class: "spinner" }), el("span", { class: "phase", text: "Connecting…" }), el("span", { class: "clock" }));
    this.turn.append(el("div", { class: "role" }, el("span", { text: label })), this.thinking, this.toolsBox, this.body, this.chip);
    this.streamed = ""; this.reasoning = ""; this.tools = [];
    this.stableLen = 0; this.codeCount = 0; this.queued = false;
    this.started = performance.now();
    const phase = this.chip.querySelector(".phase"), clock = this.chip.querySelector(".clock");
    this.phase = t => { phase.textContent = t; };
    this.tick = setInterval(() => {
      const secs = (performance.now() - this.started) / 1000;
      const tok = Math.round((this.streamed.length + this.reasoning.length) / 4);
      clock.textContent = `${secs.toFixed(1)}s` + (tok ? ` · ~${tok} tok · ~${(tok / secs).toFixed(1)} tok/s` : "");
    }, 250);
  }
  onEvent(ev) {
    if (ev.type === "delta") { this.streamed += ev.content; this.phase("Writing"); this.queuePaint(); }
    else if (ev.type === "reasoning") {
      this.reasoning += ev.content;
      this.phase("Thinking");
      if (PREFS.show_reasoning) { this.thinking.hidden = false; this.thinkBody.textContent = fix(this.reasoning); this.thinkBody.scrollTop = this.thinkBody.scrollHeight; scrollBottom(); }
    }
    else if (ev.type === "tool") this.onTool(ev);
    else if (ev.type === "status") this.phase(ev.text.replace(/…$/, ""));
    else if (ev.type === "server_error") this.phase("Server error: " + ev.message);
  }
  onTool(ev) {
    let t = [...this.tools].reverse().find(x => x.running && (!ev.tool || x.tool === ev.tool));
    if (ev.phase === "start" || !t) { t = { tool: ev.tool, provider: ev.provider || "", running: true }; this.tools.push(t); }
    if (ev.arguments) t.arguments = ev.arguments;
    if (ev.phase === "success") { t.running = false; t.ok = true; t.output = ev.output; }
    if (ev.phase === "failure") { t.running = false; t.ok = false; t.output = ev.output; }
    this.phase(t.running ? `Tool: ${t.tool}` : "Thinking");
    this.toolsBox.hidden = false;
    this.toolsBox.replaceChildren(...this.tools.map(toolItem));
    scrollBottom();
  }
  queuePaint() { if (!this.queued) { this.queued = true; setTimeout(() => this.paint(), 60); } }
  paint() {
    this.queued = false;
    const stick = nearBottom();
    const text = fix(this.streamed);
    if (!PREFS.markdown) {
      this.stable.replaceChildren(); this.body.classList.add("plain"); this.tail.textContent = text;
    } else {
      this.body.classList.remove("plain");
      // Commit everything up to the last blank line, unless that would split a ``` fence.
      const cut = text.lastIndexOf("\n\n");
      if (cut > this.stableLen) {
        const chunk = text.slice(this.stableLen, cut);
        if ((chunk.match(/^ {0,3}(```|~~~)/gm) || []).length % 2 === 0) {
          const holder = el("div");
          renderMarkdownInto(holder, chunk, { startIndex: this.codeCount + 1 });
          this.codeCount += holder.querySelectorAll(".code-block").length;
          this.stable.append(...holder.childNodes);
          this.stableLen = cut;
        }
      }
      renderMarkdownInto(this.tail, text.slice(this.stableLen), { streaming: true, startIndex: this.codeCount + 1 });
    }
    if (stick) scrollBottom(true);
  }
  finish() {
    clearInterval(this.tick);
    this.chip.remove();
    this.body.classList.remove("cursor");
    this.thinking.querySelector("summary").textContent = "Thinking";
  }
  /** Re-render the partial text in one piece (used when keeping a failed/stopped reply). */
  renderWhole() { if (this.streamed) renderMarkdownInto(this.body, fix(this.streamed)); }
}

/** POST /api/chat and feed NDJSON events to onEvent. Resolves to { end, fatal }. */
async function streamChat(reqBody, signal, onEvent) {
  let end = null, fatal = null;
  try {
    const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody), signal });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${r.status}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "end") end = ev;
        else if (ev.type === "fatal") fatal = ev;
        else onEvent(ev);
      }
    }
    if (!end && !fatal) fatal = { message: "Connection closed before the reply finished; context not advanced." };
  } catch (e) {
    fatal = e.name === "AbortError"
      ? { message: "The partial reply was not saved and the conversation context was not advanced.", stopped: true }
      : { message: `Could not reach the web server: ${e.message}` };
  }
  return { end, fatal };
}

function reasoningFor(conv) {
  const opts = modelInfo(conv.model)?.reasoning_options || [];
  return opts.includes(conv.reasoning) ? conv.reasoning : undefined;
}

async function send(opts = {}) {
  if (busy) return;
  const input = $("#input");
  const fromComposer = opts.text === undefined;
  const text = fromComposer ? input.value.trim() : opts.text;
  const attachments = (fromComposer ? pending.slice() : opts.attachments).filter(a => a.content);
  if (!text && !attachments.length) return;
  Speaker.stop();

  $$(".turn.failed").forEach(n => n.remove());
  const conv = current;
  const baseLen = editing ? editing.index : conv.messages.length;
  const prior = conv.messages.slice(0, baseLen);

  // Which LM Studio conversation to continue from. Branching from an older message reuses
  // the response ID that message was sent with; unknown IDs fall back to the saved transcript.
  let rebuild = !!opts.rebuild;
  let prevId = null;
  if (!rebuild && prior.length) {
    prevId = baseLen === conv.messages.length ? conv.previous_response_id : conv.messages[baseLen].prev_id;
    if (!prevId) { prevId = null; rebuild = true; }
  }

  const userMsg = { role: "user", content: text, attachments, ts: Date.now(), prev_id: rebuild ? null : prevId };
  const turnIndex = prior.filter(m => m.role === "user").length + 1;

  // Optimistic UI (not saved until the reply completes).
  $("#empty").hidden = true;
  $("#ctxBanner").hidden = true;
  $$(".turn").forEach(t => { if (+t.dataset.idx >= baseLen) t.hidden = true; });
  const userTurn = el("div", { class: "turn live" }, renderUserTurn(userMsg, null));
  const reply = new LiveReply("// " + conv.model);
  messagesEl().append(userTurn, reply.turn);
  scrollBottom(true);

  if (fromComposer) { input.value = ""; autosize(); pending = []; renderPending(); conv.draft = ""; }

  const extra = rebuild && prior.length ? [{ name: "conversation_history.md", kind: "text", content: transcriptForRebuild(prior) }] : [];
  const reqBody = {
    message: text,
    attachments: [...extra, ...attachments],
    model: conv.model,
    previous_response_id: prevId,
    system_prompt: conv.system_prompt,
    temperature: conv.temperature,
    max_output_tokens: conv.max_output_tokens,
    reasoning: reasoningFor(conv),
    tools: conv.tools || [],
  };

  busy = { controller: new AbortController() };
  setBusy(true);
  const { end, fatal } = await streamChat(reqBody, busy.controller.signal, ev => reply.onEvent(ev));
  busy = null;
  setBusy(false);
  setStatus("");
  reply.finish();

  if (end) {
    const asst = { role: "assistant", content: fix(end.answer), reasoning: fix(end.reasoning || reply.reasoning), stats: end.stats,
      model: conv.model, ts: Date.now(), response_id: end.response_id, tools: end.tools?.length ? end.tools : undefined };
    conv.messages = [...prior, userMsg, asst];
    conv.previous_response_id = end.response_id || null;
    if (!end.response_id) toast("No response_id returned; the next message will resend the saved history.", true);
    if (conv.title === "New chat") conv.title = (text || attachments.map(a => a.name).join(", ")).replace(/\s+/g, " ").slice(0, 60) || "Chat";
    editing = null;
    $("#editBanner").hidden = true;
    await persist(conv);
    alertIfHidden();
    if (current === conv) {
      history.replaceState(null, "", "#" + conv.id);
      renderConversation();
      $("#chatTitle").textContent = conv.title;
      scrollBottom(true);
    }
    return;
  }

  // Failure: keep partial output visible (copyable), restore input + files, don't advance context.
  if (current !== conv) return;
  if (editing) { $$(".turn").forEach(t => { if (t.dataset.idx !== undefined) t.hidden = false; }); }
  reply.renderWhole();
  userTurn.classList.add("failed");
  reply.turn.classList.add("failed");
  const box = el("div", { class: "error-box" }, el("b", { text: fatal.stopped ? "Stopped. " : "Failed. " }), fatal.message);
  box.append(el("div", { class: "muted", text: "Your message and files are back in the input box. Nothing is retried automatically." }));
  if (reply.streamed) {
    const cp = el("button", { class: "btn", type: "button", text: "Copy partial reply" });
    cp.onclick = () => copyWithFeedback(fix(reply.streamed), cp, "Copy partial reply");
    box.append(cp);
  }
  if (fatal.previous_id_rejected && prior.length) {
    box.append(el("div", { text: "LM Studio rejected the saved conversation ID — it probably restarted and forgot this chat." }));
    const rb = el("button", { class: "btn primary", type: "button", text: "Resend with saved history" });
    rb.onclick = () => send({ rebuild: true });
    box.append(rb);
  }
  reply.turn.append(box);
  scrollBottom(true);
  if (!input.value) { input.value = text; autosize(); }
  pending = [...attachments, ...pending.filter(p => !attachments.includes(p))];
  renderPending();
}

/* ======================================================================= summarize & continue */
const SUMMARY_PROMPT = "Summarize our conversation so far so it can continue in a fresh chat that has no other context. " +
  "Include: the goal, key facts and findings, decisions made, essential code, commands or indicators (verbatim when they matter), " +
  "and open questions or next steps. Be complete but compact, use Markdown headings, and write in the language the conversation mostly used.";

async function summarizeAndContinue({ rebuild = false } = {}) {
  if (busy) return;
  const conv = current;
  if (!conv.messages.length) return toast("Nothing to summarize yet.", true);
  if (editing) cancelEdit();
  Speaker.stop();
  $$(".turn.failed").forEach(n => n.remove());
  $("#ctxBanner").hidden = true;
  const reply = new LiveReply("// summary for a new chat");
  messagesEl().append(reply.turn);
  scrollBottom(true);
  const useHistory = rebuild || !conv.previous_response_id;
  const reqBody = {
    message: SUMMARY_PROMPT,
    attachments: useHistory ? [{ name: "conversation_history.md", kind: "text", content: transcriptForRebuild(conv.messages) }] : [],
    model: conv.model,
    previous_response_id: useHistory ? null : conv.previous_response_id,
    system_prompt: conv.system_prompt,
    store: false,                       // the summary request doesn't become part of the old chat
    temperature: 0.2,
    reasoning: (modelInfo(conv.model)?.reasoning_options || []).includes("off") ? "off" : undefined,
  };
  busy = { controller: new AbortController() };
  setBusy(true);
  const { end, fatal } = await streamChat(reqBody, busy.controller.signal, ev => reply.onEvent(ev));
  busy = null;
  setBusy(false);
  reply.finish();
  if (!end) {
    reply.renderWhole();
    reply.turn.classList.add("failed");
    const box = el("div", { class: "error-box" }, el("b", { text: fatal.stopped ? "Stopped. " : "Summary failed. " }), fatal.message);
    if (fatal.previous_id_rejected) {
      const rb = el("button", { class: "btn primary", type: "button", text: "Summarize from saved history" });
      rb.onclick = () => summarizeAndContinue({ rebuild: true });
      box.append(rb);
    }
    reply.turn.append(box);
    return;
  }
  reply.turn.remove();
  const summary = fix(end.answer);
  const next = { ...newConversation(), persona: conv.persona, system_prompt: conv.system_prompt, temperature: conv.temperature,
    max_output_tokens: conv.max_output_tokens, model: conv.model, reasoning: conv.reasoning ?? null, tools: [...(conv.tools || [])],
    title: "↳ " + conv.title.replace(/^↳ /, "").slice(0, 58), continued_from: conv.id };
  conv.continued_in = next.id;
  await persist(conv, { touch: false });
  openConversation(next);
  pending = [{ name: "previous_chat_summary.md", kind: "text", content: summary, size: summary.length }];
  renderPending();
  toast("Summary attached — it goes with your first message in this new chat.");
}

/* ======================================================================= exports / imports */
function conversationMarkdown(conv) {
  const out = [`# ${conv.title}`, "", `*Model:* \`${conv.model}\`  `, `*Persona:* ${conv.persona || "Default"}  `,
    `*Exported:* ${new Date().toLocaleString()}`, "", "**System prompt**", "", "> " + (conv.system_prompt || "").split("\n").join("\n> "), ""];
  for (const m of conv.messages) {
    out.push(`## ${m.role === "user" ? "You" : "Assistant"}${m.ts ? " · " + new Date(m.ts).toLocaleString() : ""}`, "");
    if (m.attachments?.length) out.push("*Attachments:* " + m.attachments.map(a => `\`${a.name}\``).join(", "), "");
    out.push(m.content, "");
  }
  return out.join("\n");
}

function allCodeFiles(conv) {
  const files = [];
  let turn = 0;
  for (const m of conv.messages) {
    if (m.role === "user") { turn++; continue; }
    extractCode(m.content).forEach((b, i) => files.push({ name: `answer${turn}_${codeFilename(b.lang, i + 1)}`, content: b.code }));
  }
  return files;
}

async function chatAction(act) {
  $("#chatMenu").hidden = true;
  const conv = current;
  const base = safeName(conv.title, "chat");
  const empty = !conv.messages.length;
  if (act === "export-md") { if (empty) return toast("This chat is empty.", true); downloadText(conversationMarkdown(conv), `${base}.md`, "text/markdown"); }
  else if (act === "copy-md") { if (empty) return toast("This chat is empty.", true); copyWithFeedback(conversationMarkdown(conv)); }
  else if (act === "export-json") {
    if (empty) return toast("This chat is empty.", true);
    downloadText(JSON.stringify({ format: "local-llm-chat", version: 1, conversation: conv }, null, 2), `${base}.json`, "application/json");
  }
  else if (act === "export-code") downloadZip(allCodeFiles(conv), `${base}_code.zip`);
  else if (act === "summarize") summarizeAndContinue();
  else if (act === "pin") { if (empty) return toast("Send a message first.", true); conv.pinned = !conv.pinned; await persist(conv, { touch: false }); toast(conv.pinned ? "Pinned" : "Unpinned"); }
  else if (act === "duplicate") {
    if (empty) return toast("This chat is empty.", true);
    const copy = { ...structuredClone(conv), id: uid(), title: conv.title + " (copy)", pinned: false, created: Date.now() };
    await persist(copy); openConversation(copy); toast("Duplicated — the copy continues independently");
  }
  else if (act === "rename") {
    if (empty) return toast("Send a message first.", true);
    const t = prompt("Chat name", conv.title);
    if (t && t.trim()) { conv.title = t.trim().slice(0, 100); await persist(conv, { touch: false }); $("#chatTitle").textContent = conv.title; }
  }
  else if (act === "delete") { if (empty) return startNewChat(); deleteConversation(conv); }
}

function sanitizeImported(c) {
  const conv = { ...newConversation(), ...c, id: uid(),
    messages: (c.messages || []).filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") };
  if (typeof conv.title !== "string") conv.title = "Imported chat";
  return conv;
}

async function importFile(file) {
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data.conversations) ? data.conversations : [data.conversation || data];
    let n = 0, last = null;
    for (const c of list) {
      if (!Array.isArray(c?.messages)) continue;
      last = sanitizeImported(c);
      await persist(last, { touch: false });
      n++;
    }
    if (!n) throw new Error("no chats found in this file");
    await repairStoredChats();
    if (n === 1) openConversation(last);
    toast(`Imported ${n} chat${n > 1 ? "s" : ""}`);
  } catch (e) { toast(`Import failed: ${e.message}`, true); }
}

function backupAll() {
  const list = conversations.filter(c => c.messages.length);
  if (!list.length) return toast("No chats to back up.", true);
  const stamp = new Date().toISOString().slice(0, 10);
  downloadText(JSON.stringify({ format: "local-llm-chat-backup", version: 1, exported: Date.now(), conversations: list }),
    `local-chat-backup-${stamp}.json`, "application/json");
}

/* ======================================================================= settings */
function fillSettings(p) {
  $("#setSystem").value = p.system_prompt;
  $("#setTemp").value = p.temperature == null ? "" : p.temperature;
}

function showTokenState() {
  $("#tokenState").textContent = CONFIG.token_from_env ? "(set by the LM_API_TOKEN environment variable)"
    : CONFIG.token_set ? `(saved: ${CONFIG.token_hint})` : "(none saved)";
}

async function postJSON(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function connectionForm() {
  const url = $("#setUrl").value.trim();
  const token = $("#setToken").value.trim();
  const clear = $("#clearToken").checked;
  return { url, token, clear, changed: url !== CONFIG.url || !!token || (clear && CONFIG.token_set) };
}

async function testConnection() {
  const f = connectionForm();
  const out = $("#connResult");
  out.className = "conn-result";
  out.textContent = "Testing…";
  try {
    const r = await postJSON("/api/connection/test", { url: f.url || null, token: f.token || null, clear_token: f.clear });
    out.className = "conn-result " + (r.ok ? "ok" : "bad");
    out.textContent = (r.ok ? "✓ " : "✕ ") + r.message;
  } catch (e) { out.className = "conn-result bad"; out.textContent = "✕ " + e.message; }
}

async function saveConnection() {
  const f = connectionForm();
  if (!f.changed) return;
  try {
    const r = await postJSON("/api/connection", { url: f.url || null, token: f.token || null, clear_token: f.clear });
    Object.assign(CONFIG, { url: r.url, server: r.server, token_set: r.token_set, token_hint: r.token_hint });
    toast(r.note || `Connection saved · ${r.server}`, !!r.note);
    loadModels();
  } catch (e) { toast(`Connection not saved: ${e.message}`, true); }
}

function openSettings() {
  $("#setUrl").value = CONFIG.url;
  $("#setToken").value = "";
  $("#setToken").type = "password";
  $("#clearToken").checked = false;
  $("#setToken").disabled = false;
  $("#connResult").textContent = "";
  showTokenState();
  const sel = $("#setPersona");
  sel.innerHTML = "";
  for (const p of allPersonas()) sel.append(el("option", { value: p.name, text: p.name + (p.builtin ? "" : "  (mine)") }));
  const sys = current.system_prompt ?? PREFS.system_prompt;
  const match = allPersonas().find(p => p.name === current.persona && p.system_prompt === sys) || allPersonas().find(p => p.system_prompt === sys);
  sel.value = match ? match.name : (current.persona || PREFS.persona);
  $("#setSystem").value = current.system_prompt ?? PREFS.system_prompt;
  const t = current.temperature ?? PREFS.temperature;
  $("#setTemp").value = t == null ? "" : t;
  const mx = current.max_output_tokens ?? PREFS.max_output_tokens;
  $("#setMaxTok").value = mx == null ? "" : mx;
  $("#setMarkdown").checked = PREFS.markdown;
  $("#setReasoning").checked = PREFS.show_reasoning;
  $("#setStats").checked = PREFS.show_stats;
  $("#setFix").checked = PREFS.fix_encoding;
  $("#setEnter").checked = PREFS.enter_sends;
  $("#setFx").checked = PREFS.effects;
  $("#setFont").value = PREFS.font_size;
  syncPersonaButtons();
  fillVoiceSettings();
  showStorageInfo();
  $("#pwCurrent").value = ""; $("#pwNew").value = ""; $("#pwResult").textContent = "";
  $("#settingsDlg").showModal();
  refreshServerStatus();
}

/** Re-read TTS/STT status (models may have finished loading since the page opened). */
async function refreshServerStatus() {
  try {
    const r = await fetch("/api/config");
    if (!r.ok) return;
    const c = await r.json();
    CONFIG.tts = c.tts; CONFIG.stt = c.stt;
    fillVoiceStatus();
    syncMicButton();
  } catch { /* offline */ }
}

function fillVoiceStatus() {
  const t = CONFIG.tts || {}, s = CONFIG.stt || {};
  const tts = t.available ? (t.ready ? "Kokoro ready." : "Kokoro installed — loading (the first run downloads the model).")
    : t.installed && t.error ? `Kokoro failed to load: ${t.error}` : t.enabled === false ? "Kokoro disabled in config.json." : "Kokoro is not installed on the server — the browser voice is used.";
  const stt = s.available ? (window.isSecureContext ? `Voice input ready (Whisper ${s.model}${s.ready ? "" : ", loading"}).` : "Voice input is installed but needs HTTPS — start the server with --https.")
    : s.installed && s.error ? `Voice input failed to load: ${s.error}` : "Voice input (faster-whisper) is not installed on the server.";
  const box = $("#voiceStatus");
  box.className = "conn-result " + (t.available ? "ok" : "");
  box.textContent = `${tts}  ${stt}`;
  $("#setTtsEngine").querySelector('option[value="kokoro"]').disabled = !t.available;
}

function fillVoiceSettings() {
  const v = CONFIG.tts?.voices || { pt: ["pf_dora", "pm_alex", "pm_santa"], en: ["af_heart"] };
  const fill = (sel, list, val) => { sel.replaceChildren(...list.map(x => el("option", { value: x, text: x }))); sel.value = list.includes(val) ? val : list[0]; };
  fill($("#setVoicePt"), v.pt, PREFS.voice_pt);
  fill($("#setVoiceEn"), v.en, PREFS.voice_en);
  $("#setTtsEngine").value = PREFS.tts_engine === "kokoro" && CONFIG.tts?.available ? "kokoro" : "browser";
  $("#setTtsSpeed").value = PREFS.tts_speed || 1;
  $("#speedVal").textContent = `${Number(PREFS.tts_speed || 1).toFixed(2)}×`;
  $("#setSttLang").value = PREFS.stt_lang || "";
  fillVoiceStatus();
}

/* ======================================================================= storage */
function storageStats() {
  let total = 0, images = 0, imageCount = 0;
  for (const c of conversations) {
    total += JSON.stringify(c).length;
    for (const m of c.messages) for (const a of m.attachments || [])
      if (a.kind === "image" && a.content) { images += a.content.length; imageCount++; }
  }
  return { total, images, imageCount, chats: conversations.filter(c => c.messages.length).length };
}

function showStorageInfo() {
  const s = storageStats();
  $("#storageInfo").textContent = `${s.chats} chats · about ${fmtBytes(s.total)} in total · ${s.imageCount} stored image${s.imageCount === 1 ? "" : "s"} (${fmtBytes(Math.round(s.images * 0.75))})`;
}

async function stripImages(olderThanDays) {
  const cutoff = olderThanDays == null ? Infinity : Date.now() - olderThanDays * 864e5;
  if (olderThanDays == null && !confirm("Remove every stored image from all chats in this browser?")) return;
  let removed = 0;
  for (const c of conversations) {
    let changed = false;
    for (const m of c.messages) {
      if ((m.ts || c.updated) >= cutoff) continue;
      for (const a of m.attachments || []) if (a.kind === "image" && a.content) { a.content = null; changed = true; removed++; }
    }
    if (changed) await DB.put(c).catch(() => {});
  }
  showStorageInfo();
  if (!busy) renderConversation();
  toast(removed ? `Removed ${removed} image${removed > 1 ? "s" : ""}.` : "No images to remove.");
}

/* ======================================================================= account */
async function changePassword() {
  const out = $("#pwResult");
  out.className = "conn-result";
  try {
    await postJSON("/api/password", { current: $("#pwCurrent").value, new: $("#pwNew").value });
    out.className = "conn-result ok"; out.textContent = "✓ Password changed. Other devices must log in again.";
    $("#pwCurrent").value = ""; $("#pwNew").value = "";
  } catch (e) { out.className = "conn-result bad"; out.textContent = "✕ " + e.message; }
}

async function logout() {
  Speaker.stop();
  if (current?.messages.length) { current.draft = $("#input").value; await DB.put(current).catch(() => {}); }
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.replace("/login");
}

function syncMicButton() {
  const b = $("#micBtn");
  b.hidden = !CONFIG.stt?.available;
  b.classList.toggle("needs-https", !window.isSecureContext);
  b.title = window.isSecureContext ? "Voice input (Ctrl+M)" : "Voice input needs HTTPS — start the server with --https";
}

function syncPersonaButtons() {
  const p = allPersonas().find(x => x.name === $("#setPersona").value);
  $("#delPersona").hidden = !p || p.builtin;
}

function readNumber(id, { min, max, int = false }) {
  const raw = $(id).value.trim();
  if (raw === "") return { ok: true, value: null };
  const v = Number(raw);
  const ok = isFinite(v) && v >= min && (max == null || v <= max) && (!int || Number.isInteger(v));
  return { ok, value: ok ? v : null };
}

async function saveSettings() {
  await saveConnection();
  const sys = $("#setSystem").value.trim() || CONFIG.system_prompt;
  const t = readNumber("#setTemp", { min: 0, max: 1 });
  const mx = readNumber("#setMaxTok", { min: 1, int: true });
  if (!t.ok) toast("Temperature must be between 0 and 1 — kept the previous value.", true);
  if (!mx.ok) toast("Max output tokens must be a positive whole number — ignored.", true);
  const persona = $("#setPersona").value;
  const p = allPersonas().find(x => x.name === persona);
  const personaName = p && p.system_prompt === sys ? persona : (allPersonas().find(x => x.system_prompt === sys)?.name || "Custom");
  Object.assign(PREFS, {
    persona: personaName, system_prompt: sys, temperature: t.ok ? t.value : PREFS.temperature, max_output_tokens: mx.ok ? mx.value : PREFS.max_output_tokens,
    markdown: $("#setMarkdown").checked, show_reasoning: $("#setReasoning").checked, show_stats: $("#setStats").checked,
    fix_encoding: $("#setFix").checked, enter_sends: $("#setEnter").checked, effects: $("#setFx").checked, font_size: $("#setFont").value,
    tts_engine: $("#setTtsEngine").value, tts_speed: Number($("#setTtsSpeed").value) || 1,
    voice_pt: $("#setVoicePt").value, voice_en: $("#setVoiceEn").value, stt_lang: $("#setSttLang").value,
  });
  savePrefs();
  applyLook();
  if (sys !== current.system_prompt && busy) {
    current.temperature = PREFS.temperature; current.max_output_tokens = PREFS.max_output_tokens;
    renderConversation();
    toast("Saved. The new system prompt will be used in your next new chat.");
  } else if (sys !== current.system_prompt && current.messages.length) {
    startNewChat();
    toast("System prompt changed — started a new chat.");
  } else {
    Object.assign(current, { system_prompt: sys, persona: personaName, temperature: PREFS.temperature, max_output_tokens: PREFS.max_output_tokens });
    if (!current.messages.length && p && personaName === p.name) {
      Object.assign(current, { reasoning: p.reasoning ?? null, tools: p.tools?.length ? knownTools(p.tools) : defaultTools() });
      if (p.model) current.model = p.model;
    }
    if (current.messages.length) await persist(current, { touch: false });
    if (PREFS.fix_encoding) await repairStoredChats();
    renderConversation();
  }
}

function savePersona() {
  const name = prompt("Persona name", $("#setPersona").value === "Default" ? "" : $("#setPersona").value);
  if (!name || !name.trim()) return;
  const t = readNumber("#setTemp", { min: 0, max: 1 });
  const p = { name: name.trim().slice(0, 40), system_prompt: $("#setSystem").value.trim() || CONFIG.system_prompt, temperature: t.ok ? t.value : null,
    model: current.model || null, reasoning: current.reasoning ?? null, tools: [...(current.tools || [])] };
  PREFS.user_personas = [...(PREFS.user_personas || []).filter(x => x.name !== p.name), p];
  savePrefs();
  const sel = $("#setPersona");
  if (![...sel.options].some(o => o.value === p.name)) sel.append(el("option", { value: p.name, text: p.name + "  (mine)" }));
  sel.value = p.name;
  syncPersonaButtons();
  toast(`Persona "${p.name}" saved in this browser`);
}

function deletePersona() {
  const name = $("#setPersona").value;
  if (!confirm(`Delete persona "${name}"?`)) return;
  PREFS.user_personas = (PREFS.user_personas || []).filter(x => x.name !== name);
  savePrefs();
  $("#setPersona").querySelector(`option[value="${CSS.escape(name)}"]`)?.remove();
  $("#setPersona").value = "Default";
  fillSettings(allPersonas().find(x => x.name === "Default"));
  syncPersonaButtons();
}

/* ======================================================================= input & events */
function autosize() { const i = $("#input"); i.style.height = "auto"; i.style.height = Math.min(i.scrollHeight, window.innerHeight * 0.4) + "px"; }

let draftTimer;
function bindEvents() {
  const input = $("#input");
  input.addEventListener("input", () => {
    autosize();
    current.draft = input.value;
    clearTimeout(draftTimer);
    if (current.messages.length) draftTimer = setTimeout(() => persist(current, { touch: false }), 800);
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl || (PREFS.enter_sends && !isTouch())) { e.preventDefault(); send(); }
    } else if (e.key === "ArrowUp" && !input.value && !editing) {
      const i = current.messages.map(m => m.role).lastIndexOf("user");
      if (i >= 0) { e.preventDefault(); startEdit(i); }
    }
  });
  $("#sendBtn").onclick = () => (busy ? busy.controller.abort() : send());
  $("#cancelEdit").onclick = () => cancelEdit();
  document.addEventListener("keydown", e => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") {
      if ($("dialog[open]")) return;
      if (Mic.active) Mic.stop(true);
      else if (busy) busy.controller.abort();
      else if (editing) cancelEdit();
      else if (Speaker.btn) Speaker.stop();
    }
    if (ctrl && e.key.toLowerCase() === "m" && CONFIG.stt?.available) { e.preventDefault(); Mic.toggle(); }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); startNewChat(); }
    if (ctrl && e.key.toLowerCase() === "k") { e.preventDefault(); $("#app").classList.add("side-open"); $("#search").focus(); }
    if (ctrl && e.key === "/") { e.preventDefault(); $("#helpDlg").showModal(); }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === "c") {
      const last = [...current.messages].reverse().find(m => m.role === "assistant");
      const blocks = last ? extractCode(last.content) : [];
      if (blocks.length) { e.preventDefault(); copyText(blocks[blocks.length - 1].code).then(ok => toast(ok ? "Copied last code block" : "Copy failed", !ok)); }
    }
  });

  $("#attachBtn").onclick = () => $("#fileInput").click();
  $("#fileInput").onchange = e => { addFiles(e.target.files); e.target.value = ""; };
  input.addEventListener("paste", e => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", e => { if (hasFiles(e)) { dragDepth++; $("#dropOverlay").hidden = false; } });
  window.addEventListener("dragleave", e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $("#dropOverlay").hidden = true; } });
  window.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $("#dropOverlay").hidden = true;
    addFiles(e.dataTransfer.files);
  });

  messagesEl().addEventListener("scroll", updateScrollBtn, { passive: true });
  $("#scrollDown").onclick = () => scrollBottom(true);

  $("#newChat").onclick = () => { startNewChat(); closeSidebar(); };
  $("#search").addEventListener("input", renderSidebar);
  $("#menuBtn").onclick = () => $("#app").classList.toggle("side-open");
  $("#scrim").onclick = closeSidebar;

  $("#modelSelect").onchange = async e => {
    current.model = e.target.value;
    PREFS.model = e.target.value;
    savePrefs();
    if (current.messages.length) await persist(current, { touch: false });
    renderPending();
    syncReasoningSelect();
    renderToolsMenu();
    updateContextMeter();
  };
  $("#reasoningSelect").onchange = async e => {
    current.reasoning = e.target.value || null;
    if (current.messages.length) await persist(current, { touch: false });
  };

  const closeMenus = except => { for (const id of ["#chatMenu", "#toolsMenu"]) if (id !== except) $(id).hidden = true; };
  $("#chatMenuBtn").onclick = e => { e.stopPropagation(); closeMenus("#chatMenu"); $("#chatMenu").hidden = !$("#chatMenu").hidden; };
  $("#toolsBtn").onclick = e => { e.stopPropagation(); closeMenus("#toolsMenu"); $("#toolsMenu").hidden = !$("#toolsMenu").hidden; };
  $("#chatMenu").addEventListener("click", e => { const act = e.target.closest("[data-act]")?.dataset.act; if (act) chatAction(act); });
  document.addEventListener("click", e => { if (!e.target.closest(".menu-wrap")) closeMenus(); });

  $("#summarizeBtn").onclick = () => summarizeAndContinue();
  $("#ctxDismiss").onclick = async () => { current.ctx_dismissed = true; $("#ctxBanner").hidden = true; if (current.messages.length) await persist(current, { touch: false }); };
  $("#micBtn").onclick = () => Mic.toggle();
  $("#logoutBtn").onclick = logout;
  $("#changePw").onclick = changePassword;
  $("#stripOldImages").onclick = () => stripImages(7);
  $("#stripAllImages").onclick = () => stripImages(null);
  $("#setTtsSpeed").oninput = e => { $("#speedVal").textContent = `${Number(e.target.value).toFixed(2)}×`; };
  $("#testVoice").onclick = () => Speaker.toggle("Olá! Este é um teste da voz em português. And this sentence is spoken in English.",
    $("#testVoice span"), { engine: $("#setTtsEngine").value, speed: Number($("#setTtsSpeed").value) || 1,
      voices: { pt: $("#setVoicePt").value, en: $("#setVoiceEn").value } });

  $("#settingsBtn").onclick = () => { closeSidebar(); openSettings(); };
  $("#helpBtn").onclick = () => { closeSidebar(); $("#helpDlg").showModal(); };
  $("#settingsForm").addEventListener("submit", e => { if (e.submitter?.value === "save") saveSettings(); });
  $("#setPersona").onchange = () => { const p = allPersonas().find(x => x.name === $("#setPersona").value); if (p) fillSettings(p); syncPersonaButtons(); };
  $("#savePersona").onclick = savePersona;
  $("#testConn").onclick = testConnection;
  $("#showToken").onclick = () => { const t = $("#setToken"); t.type = t.type === "password" ? "text" : "password"; };
  $("#clearToken").onchange = e => { $("#setToken").disabled = e.target.checked; };
  $("#delPersona").onclick = deletePersona;
  $("#resetSettings").onclick = () => {
    $("#setPersona").value = "Default";
    fillSettings({ system_prompt: CONFIG.system_prompt, temperature: CONFIG.temperature });
    $("#setMaxTok").value = CONFIG.max_output_tokens ?? "";
    $("#setMarkdown").checked = CONFIG.markdown;
    $("#setReasoning").checked = CONFIG.show_reasoning;
    $("#setStats").checked = CONFIG.show_stats;
    $("#setFix").checked = CONFIG.fix_encoding;
    $("#setEnter").checked = true; $("#setFx").checked = true; $("#setFont").value = "m";
    $("#setTtsEngine").value = CONFIG.tts?.available ? "kokoro" : "browser";
    $("#setTtsSpeed").value = CONFIG.tts?.speed || 1; $("#speedVal").textContent = `${Number(CONFIG.tts?.speed || 1).toFixed(2)}×`;
    syncPersonaButtons();
  };

  $("#importBtn").onclick = () => $("#importInput").click();
  $("#backupBtn").onclick = backupAll;
  $("#importInput").onchange = e => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ""; };

  window.addEventListener("beforeunload", e => {
    if (current?.messages.length) { current.draft = input.value; DB.put(current).catch(() => {}); }
    if (busy) { e.preventDefault(); e.returnValue = ""; }
  });
  setInterval(loadModels, 60000);
}

/* ======================================================================= boot */

// Session expired / password changed elsewhere: any 401 from the API goes back to the login page.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const r = await nativeFetch(...args);
  if (r.status === 401 && String(args[0]).startsWith("/api/")) {
    if (current?.messages.length) { current.draft = $("#input").value; await DB.put(current).catch(() => {}); }
    location.replace("/login");
  }
  return r;
};

async function boot() {
  try {
    const r = await fetch("/api/config");
    if (r.status === 401) return;
    CONFIG = await r.json();
  } catch (e) {
    document.body.textContent = "Could not load configuration from the web server: " + e.message;
    return;
  }
  loadPrefs();
  applyLook();
  syncMicButton();
  $("#linkInfo").textContent = `LINK ${CONFIG.server}`;
  bindEvents();
  try {
    await DB.open();
    conversations = (await DB.all()).sort((a, b) => b.updated - a.updated);
    await repairStoredChats();
  } catch (e) {
    toast("Local storage unavailable — chats won't be saved in this browser.", true);
    DB.put = async () => {}; DB.del = async () => {};
  }
  const fromHash = conversations.find(c => "#" + c.id === location.hash);
  current = fromHash || newConversation();
  $("#input").value = current.draft || "";
  autosize();
  renderConversation();
  renderSidebar();
  loadModels();
  if (!isTouch()) $("#input").focus();
}

boot();
