"use strict";
(() => {
  const msg = document.getElementById("msg");
  const show = (text, ok = false) => { if (msg) { msg.textContent = text; msg.className = "login-msg " + (ok ? "ok" : "bad"); } };

  async function post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  const login = document.getElementById("loginForm");
  if (login) login.addEventListener("submit", async e => {
    e.preventDefault();
    const btn = login.querySelector("button");
    btn.disabled = true;
    show("Authenticating…", true);
    try {
      await post("/api/login", { password: document.getElementById("password").value,
        remember: document.getElementById("remember").checked });
      location.replace("/");
    } catch (err) {
      show(err.message);
      document.getElementById("password").select();
    } finally { btn.disabled = false; }
  });

  const setup = document.getElementById("setupForm");
  if (setup) setup.addEventListener("submit", async e => {
    e.preventDefault();
    const p1 = document.getElementById("password").value, p2 = document.getElementById("password2").value;
    if (p1 !== p2) return show("The two passwords differ.");
    try {
      await post("/api/setup", { password: p1 });
      location.replace("/");
    } catch (err) { show(err.message); }
  });
})();
