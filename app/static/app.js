(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const thread = $("thread"), scroller = $("scroll"), input = $("input"), sendBtn = $("send");
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let busy = false;

  // ---- session ------------------------------------------------------------
  const newId = () =>
    (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2))
      .replace(/[^A-Za-z0-9_-]/g, "");
  function loadSession() {
    try {
      let id = localStorage.getItem("chronos.session");
      if (!id) { id = newId(); localStorage.setItem("chronos.session", id); }
      return id;
    } catch { return newId(); }
  }
  let sessionId = loadSession();
  const showSession = () => { $("session").textContent = "session " + sessionId.slice(0, 8); };

  // ---- formatting ---------------------------------------------------------
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const utcClock = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
  const secs = (ms) => (ms / 1000).toFixed(ms < 10000 ? 2 : 1).replace(/0$/, "") + "s";
  const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

  function cite(url, label) {
    const generic = !label || /^(source|sources|link|here|\d+)$/i.test(label.trim());
    const text = generic ? host(url) : label;
    return `<a class="cite" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}">${esc(text)}</a>`;
  }

  const INLINE = /(`[^`\n]+`)|\[([^\]\n]*)\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)|(https?:\/\/[^\s<>\])"'`]+)/g;
  function emphasis(raw) {
    return esc(raw)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\s][^*\n]*)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  }
  function inline(text) {
    let out = "", last = 0, m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(text))) {
      out += emphasis(text.slice(last, m.index));
      if (m[1]) out += `<code>${esc(m[1].slice(1, -1))}</code>`;
      else if (m[3]) out += cite(m[3], m[2]);
      else {
        const url = m[4].replace(/[.,;:!?*_]+$/, "");
        out += cite(url, "") + esc(m[4].slice(url.length));
      }
      last = m.index + m[0].length;
    }
    return out + emphasis(text.slice(last));
  }

  // Small, safe markdown subset: everything is escaped before any tag is added.
  function markdown(src) {
    const html = [];
    const parts = src.split(/```/);
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        html.push(`<pre><code>${esc(part.replace(/^[\w+-]*\n/, "").replace(/\n$/, ""))}</code></pre>`);
        return;
      }
      let para = [], list = null;
      const flushPara = () => { if (para.length) { html.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
      const flushList = () => { if (list) { html.push(`<${list.tag}>${list.items.map((t) => `<li>${inline(t)}</li>`).join("")}</${list.tag}>`); list = null; } };
      for (const line of part.split("\n")) {
        const h = line.match(/^#{1,6}\s+(.*)$/);
        const ul = line.match(/^\s*[-*•]\s+(.*)$/);
        const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (h) { flushPara(); flushList(); html.push(`<h3>${inline(h[1])}</h3>`); }
        else if (ul || ol) {
          flushPara();
          const tag = ul ? "ul" : "ol";
          if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
          list.items.push((ul || ol)[1]);
        }
        else if (!line.trim()) { flushPara(); flushList(); }
        else if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += " " + line.trim(); }
        else { flushList(); para.push(line); }
      }
      flushPara(); flushList();
    });
    return html.join("");
  }

  // ---- message rendering --------------------------------------------------
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; };

  function setTime(node, iso) {
    const d = new Date(iso);
    node.textContent = `[${utcClock(d)}]`;
    node.title = `${d.toLocaleString()} (${TZ})\n${iso}`;
  }

  function addMessage(role, content, iso) {
    $("empty").hidden = true;
    const msg = el("article", `msg ${role}`);
    const head = el("div", "msg-head");
    head.append(el("span", "role", role === "user" ? "You" : "Chronos"));
    const ts = el("time", "ts");
    if (iso) setTime(ts, iso); else ts.textContent = "[--:--:-- UTC]";
    const badges = el("span", "badges");
    head.append(ts, badges);
    const body = el("div", "msg-body");
    if (role === "user") body.textContent = content; else body.innerHTML = markdown(content);
    msg.append(head, body);
    thread.append(msg);
    return { msg, head, ts, badges, body };
  }

  function addBadges(view, meta) {
    view.badges.textContent = "";
    if (!meta) return;
    if (meta.searched) view.badges.append(el("span", "badge web", "web"));
    if (meta.ttft_ms != null) {
      const b = el("span", "badge ok", "TTFT " + secs(meta.ttft_ms));
      b.title = "Time from request receipt to first streamed token (server-side)";
      view.badges.append(b);
    }
    if (meta.search_ms) view.badges.append(el("span", "badge", "search " + secs(meta.search_ms)));
    if (meta.total_ms != null) view.badges.append(el("span", "badge", "total " + secs(meta.total_ms)));
    if (meta.removed_urls) {
      const b = el("span", "badge warn", `${meta.removed_urls} unverified link${meta.removed_urls > 1 ? "s" : ""} removed`);
      b.title = "The model produced a URL that was not in the search results, so it was stripped.";
      view.badges.append(b);
    }
  }

  function setSources(view, sources) {
    let box = view.msg.querySelector(".sources");
    if (!sources || !sources.length) { if (box) box.remove(); return; }
    if (!box) { box = el("div", "sources"); view.msg.append(box); }
    box.innerHTML = `<span class="sources-label">Sources</span>` +
      sources.map((s, i) => `<a class="cite" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.title + "\n" + s.url)}">${i + 1} · ${esc(host(s.url))}</a>`).join("");
  }

  function setStatus(view, state, query, detail) {
    let bar = view.msg.querySelector(".status");
    if (!bar) { bar = el("div", "status"); view.head.after(bar); }
    bar.className = "status" + (state === "search_failed" ? " failed" : state === "searched" ? " finished" : "");
    const label = state === "searching" ? "Searching web…" : state === "searched" ? "Searched web" : (detail || "Search failed");
    bar.textContent = "";
    bar.append(el("span", "dot"), el("span", null, label));
    if (query) bar.append(el("span", "q", query));
  }

  // ---- chat ---------------------------------------------------------------
  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    busy = true; sendBtn.disabled = true;
    input.value = ""; autosize();

    const userView = addMessage("user", text, null);
    const view = addMessage("assistant", "", null);
    view.body.innerHTML = `<span class="caret"></span>`;
    toBottom();

    let answer = "", frame = 0, lastQuery = "", failed = false;
    const paint = () => {
      frame = 0;
      const stick = nearBottom();
      view.body.innerHTML = markdown(answer) + (busy ? `<span class="caret"></span>` : "");
      if (stick) toBottom();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };

    const handle = (ev) => {
      if (ev.type === "meta") setTime(userView.ts, ev.created_at);
      else if (ev.type === "status") {
        if (ev.state === "search_failed") failed = true;
        lastQuery = ev.query || lastQuery;
        setStatus(view, ev.state, ev.query, ev.detail);
        if (nearBottom()) toBottom();
      }
      else if (ev.type === "sources") setSources(view, ev.sources);
      else if (ev.type === "token") {
        if (!answer && lastQuery && !failed) setStatus(view, "searched", lastQuery);
        answer += ev.text; schedule();
      }
      else if (ev.type === "error") view.msg.append(el("div", "error", ev.message));
      else if (ev.type === "done") { setTime(view.ts, ev.created_at); addBadges(view, ev); }
    };

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, message: text, timezone: TZ }),
      });
      if (!resp.ok || !resp.body) throw new Error(`Request failed (HTTP ${resp.status})`);
      const reader = resp.body.getReader(), decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, cut); buf = buf.slice(cut + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          if (data) { try { handle(JSON.parse(data)); } catch (e) { console.error(e); } }
        }
      }
    } catch (err) {
      view.msg.append(el("div", "error", err.message || "Connection lost."));
    } finally {
      busy = false; sendBtn.disabled = false;
      if (frame) cancelAnimationFrame(frame);
      paint();
      if (!answer) view.body.remove();
      input.focus();
    }
  }

  async function loadHistory() {
    try {
      const resp = await fetch("/api/history?session_id=" + encodeURIComponent(sessionId));
      const { messages } = await resp.json();
      for (const m of messages) {
        const view = addMessage(m.role, m.content, m.created_at);
        if (m.role === "assistant" && m.meta) {
          addBadges(view, m.meta); setSources(view, m.meta.sources);
          if (m.meta.queries && m.meta.queries.length) setStatus(view, "searched", m.meta.queries.join(" · "));
        }
      }
      toBottom();
    } catch (e) { console.error(e); }
  }

  // ---- wiring -------------------------------------------------------------
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });
  $("composer").addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });
  $("suggestions").addEventListener("click", (e) => { if (e.target.tagName === "BUTTON") send(e.target.textContent); });
  $("new-session").addEventListener("click", () => {
    if (busy) return;
    sessionId = newId();
    try { localStorage.setItem("chronos.session", sessionId); } catch {}
    thread.querySelectorAll(".msg").forEach((n) => n.remove());
    $("empty").hidden = false;
    showSession(); input.focus();
  });

  const tick = () => { $("clock").textContent = utcClock(new Date()); };
  tick(); setInterval(tick, 1000);
  showSession();
  loadHistory();
})();
