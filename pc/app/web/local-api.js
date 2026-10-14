/* DjFah Radio — τοπικός «διακομιστής» για το κινητό.
   Κάνει ό,τι κάνει το server.py στον υπολογιστή, μέσα στην ίδια την εφαρμογή:
   βάση σταθμών, ποιότητα ροών, ιστορικό, αγαπημένα, Excel. Φορτώνεται μόνο στο Android. */
(function () {
  "use strict";
  const CAP = window.Capacitor;
  if (!CAP || !CAP.isNativePlatform || !CAP.isNativePlatform()) return;
  const RP = (CAP.Plugins && CAP.Plugins.RadioPlayer) || (CAP.registerPlugin && CAP.registerPlugin("RadioPlayer"));
  window.RadioPlayer = RP;

  const VERSION = "1.1.0";
  const KEY = "djfah-radio-data";
  const CATALOG_URL = "https://raw.githubusercontent.com/fahtheo-Thodoris/djfah-radio/main/stations.json";
  const RB_HOSTS = ["all.api.radio-browser.info", "de1.api.radio-browser.info", "de2.api.radio-browser.info", "fi1.api.radio-browser.info", "at1.api.radio-browser.info", "nl1.api.radio-browser.info"];
  const RESOLVE_TTL = 3 * 24 * 3600;
  const NON_MUSIC = new Set(["news", "talk", "sports", "sport", "religion", "religious", "christian", "podcast", "politics", "information", "comedy", "church", "islam", "quran", "bible"]);

  /* ---------------------------------------------------------------- αποθήκευση */
  let D;
  try { D = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { D = {}; }
  for (const [k, v] of [["settings", {}], ["favorites", []], ["mystations", []], ["history", {}], ["resolved", {}], ["health", {}], ["spotify_lists", []], ["last", null]]) if (D[k] === undefined) D[k] = v;
  D.settings.hq_only = D.settings.hq_only ?? true;
  D.settings.volume = D.settings.volume ?? 0.8;
  D.settings.catalog_url = D.settings.catalog_url ?? "";
  D.settings.export_dir = "Μενού «Κοινοποίηση» του κινητού";
  let saveT = null;
  function save(now) {
    clearTimeout(saveT);
    const w = () => { try { localStorage.setItem(KEY, JSON.stringify(D)); } catch (e) { console.warn("save", e); } };
    if (now) w(); else saveT = setTimeout(w, 800);
  }
  document.addEventListener("visibilitychange", () => { if (document.hidden) save(true); });

  /* ---------------------------------------------------------------- κατάλογος */
  let CATALOG = { stations: [], countries: [], genres: {} }, IDX = {};
  async function loadCatalog() {
    let bundled = null, local = null;
    try { bundled = await (await fetch("stations.json")).json(); } catch (e) { }
    try { local = JSON.parse(localStorage.getItem(KEY + "-catalog") || "null"); } catch (e) { }
    CATALOG = (local && bundled && String(local.version) > String(bundled.version)) ? local : (bundled || local || CATALOG);
    IDX = {}; for (const s of CATALOG.stations) IDX[s.k] = s;
  }
  function findSt(k) { return IDX[k] || D.mystations.find((s) => s.k === k) || null; }
  async function updateCatalog() {
    const url = (D.settings.catalog_url || "").trim() || CATALOG_URL;
    try {
      const c = await (await timedFetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), 20000)).json();
      if (!Array.isArray(c.stations) || !c.stations.length) throw new Error("κενή λίστα");
      if (String(c.version || "") <= String(CATALOG.version || "")) return { ok: true, message: "Η λίστα σταθμών είναι ήδη η πιο πρόσφατη." };
      localStorage.setItem(KEY + "-catalog", JSON.stringify(c));
      CATALOG = c; IDX = {}; for (const s of c.stations) IDX[s.k] = s;
      return { ok: true, message: `Η λίστα ενημερώθηκε (έκδοση ${c.version}).` };
    } catch (e) { return { ok: false, message: "Η ενημέρωση δεν έγινε: " + e.message }; }
  }

  /* ---------------------------------------------------------------- δίκτυο */
  async function timedFetch(url, ms = 12000) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(url, { signal: ac.signal, headers: { "User-Agent": "DjFahRadio/" + VERSION + " (Android)" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r;
    } finally { clearTimeout(t); }
  }
  let rbGood = null;
  async function rb(path, params) {
    const q = params ? "?" + new URLSearchParams(params).toString() : "";
    const bases = (rbGood ? [rbGood] : []).concat(RB_HOSTS.map((h) => "https://" + h).filter((b) => b !== rbGood));
    let last;
    for (const b of bases) {
      try { const j = await (await timedFetch(b + path + q)).json(); rbGood = b; return j; }
      catch (e) { last = e; }
    }
    const err = new Error("Η βάση σταθμών δεν απαντά (" + (last && last.message) + ")"); err.data = { offline_net: !navigator.onLine }; throw err;
  }

  /* ---------------------------------------------------------------- ποιότητα / ονόματα */
  function qualityOf(codec, bitrate, hls) {
    const c = String(codec || "").toUpperCase(), b = parseInt(bitrate || 0, 10);
    if (c.includes("FLAC")) return "hq";
    if (hls && !b) return (c.includes("AAC") || !c) ? "hq" : "unknown";
    if (!b) return "unknown";
    if (/AAC|OPUS|OGG|VORBIS/.test(c)) return b >= 128 ? "hq" : b >= 96 ? "std" : "low";
    return b >= 192 ? "hq" : b >= 128 ? "std" : "low";
  }
  const QR = { hq: 4, unknown: 2.5, std: 2, low: 0 };
  function score(s) { return (QR[s.quality] || 0) * 10 + Math.min(s.bitrate || 0, 320) / 40 + (s.hls ? 0 : 3) + (s.ok ? 6 : 0) + Math.min(s.votes || 0, 5000) / 1000; }
  const GREEK = { α: "a", β: "v", γ: "g", δ: "d", ε: "e", ζ: "z", η: "i", θ: "th", ι: "i", κ: "k", λ: "l", μ: "m", ν: "n", ξ: "x", ο: "o", π: "p", ρ: "r", σ: "s", ς: "s", τ: "t", υ: "y", φ: "f", χ: "ch", ψ: "ps", ω: "o" };
  function norm(s) {
    s = String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
    s = [...s].map((c) => GREEK[c] || c).join("");
    return s.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }
  function lev(a, b) {
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  function nameSim(q, name) {
    const a = norm(q), b = norm(name);
    if (!a || !b) return 0; if (a === b) return 1;
    let r = 1 - lev(a, b) / Math.max(a.length, b.length);
    const ta = new Set(a.split(" ")), tb = new Set(b.split(" "));
    if ([...ta].every((t) => tb.has(t))) r = Math.max(r, 0.82 - 0.03 * Math.max(0, tb.size - ta.size));
    if (b.startsWith(a + " ") || b.endsWith(" " + a)) r = Math.max(r, 0.8);
    return r;
  }
  function toStream(r) {
    const url = r.url_resolved || r.url || ""; const hls = !!r.hls || url.toLowerCase().includes(".m3u8");
    return { uuid: r.stationuuid, name: r.name || "", url, codec: r.codec || "", bitrate: parseInt(r.bitrate || 0, 10), hls, ok: !!r.lastcheckok,
      votes: parseInt(r.votes || 0, 10), favicon: r.favicon || "", homepage: r.homepage || "", tags: r.tags || "", cc: r.countrycode || "", quality: qualityOf(r.codec, r.bitrate, hls) };
  }
  async function resolve(st, force) {
    const cached = D.resolved[st.k];
    if (cached && !force && Date.now() / 1000 - (cached.t || 0) < RESOLVE_TTL) return cached;
    let streams = [];
    try {
      if (st.uuids && st.uuids.length) streams = (await rb("/json/stations/byuuid", { uuids: st.uuids.join(",") })).map(toStream);
      if (st.url && !streams.length) streams = [{ uuid: null, name: st.n, url: st.url, codec: "", bitrate: 0, hls: st.url.toLowerCase().includes(".m3u8"), ok: true, votes: 0, favicon: st.favicon || "", cc: st.cc || "", quality: "unknown" }];
      if (!streams.length) {
        const found = new Map(); let best = 0;
        for (const q of (st.q && st.q.length ? st.q : [st.n])) {
          const p = { name: q, hidebroken: "false", order: "votes", reverse: "true", limit: "40" };
          if (st.cc) p.countrycode = st.cc;
          for (const r of await rb("/json/stations/search", p)) {
            const sim = nameSim(q, r.name); if (sim < 0.62) continue;
            const prev = found.get(r.stationuuid); if (!prev || prev[0] < sim) found.set(r.stationuuid, [sim, r]);
            best = Math.max(best, sim);
          }
          if (found.size) break;
        }
        streams = [...found.values()].filter(([sim]) => sim >= best - 0.06).map(([, r]) => toStream(r));
      }
    } catch (e) { if (cached) return cached; throw e; }
    const seen = new Set(), uniq = [];
    for (const s of streams.sort((a, b) => score(b) - score(a))) if (s.url && !seen.has(s.url)) { seen.add(s.url); uniq.push(s); }
    const info = { t: Date.now() / 1000, streams: uniq.slice(0, 6), quality: uniq.length ? uniq[0].quality : "none",
      favicon: (uniq.find((s) => s.favicon) || {}).favicon || "", any_ok: uniq.some((s) => s.ok) };
    D.resolved[st.k] = info; save();
    return info;
  }
  const RS = { running: false, done: 0, total: 0 };
  async function resolveAll() {
    if (RS.running) return; RS.running = true;
    try {
      const items = CATALOG.stations.concat(D.mystations);
      const todo = items.filter((s) => Date.now() / 1000 - ((D.resolved[s.k] || {}).t || 0) > RESOLVE_TTL);
      RS.total = todo.length; RS.done = 0;
      for (const s of todo) {
        try { const i = await resolve(s); if (i.streams.length && !i.any_ok) health(s.k, false); }
        catch (e) { if (!navigator.onLine) await new Promise((r) => setTimeout(r, 20000)); }
        RS.done++;
        await new Promise((r) => setTimeout(r, 120));
      }
    } finally { RS.running = false; }
  }

  /* ---------------------------------------------------------------- υγεία */
  const today = () => new Date().toISOString().slice(0, 10);
  function health(k, ok) {
    const h = D.health[k] = D.health[k] || { fails: [], last_ok: null };
    if (ok) { h.last_ok = today(); h.fails = []; }
    else if (!h.fails.includes(today())) h.fails = h.fails.concat(today()).slice(-10);
    save();
  }
  function isOffline(k) {
    const h = D.health[k]; if (!h) return false;
    const f = (h.fails || []).slice().sort(); if (f.length < 3) return false;
    const r = f.slice(-3); if ((Date.now() - Date.parse(r[0])) / 864e5 > 6) return false;
    return !h.last_ok || h.last_ok < r[0];
  }

  /* ---------------------------------------------------------------- τίτλοι / ιστορικό */
  const NOW = {};
  const JUNK = /^(\s*|-+|\.+|unknown|unknown - unknown|advert|advertisement|commercial|jingle|station id|ad break|sponsor|n\/a|null|none|live|on air)$/i;
  function splitTitle(raw, sname) {
    const t = String(raw || "").replace(/\s+/g, " ").trim().replace(/^['"]|['"]$/g, "");
    if (!t || JUNK.test(t) || /https?:\/\//.test(t) || t.length > 220) return null;
    if (sname && norm(t) === norm(sname)) return null;
    for (const sep of [" - ", " – ", " — ", " -- ", " | ", " / "]) {
      const i = t.indexOf(sep);
      if (i > 0 && t.slice(i + sep.length).trim()) return [t.slice(0, i).trim(), t.slice(i + sep.length).trim(), t];
    }
    return ["", t, t];
  }
  function recordTitle(k, raw, sname, src = "stream") {
    const p = splitTitle(raw, sname);
    if (!p) { NOW[k] = { artist: "", title: "", raw: raw || "", ts: Date.now() / 1000, meta: true }; return; }
    const [artist, title, rawc] = p;
    if (NOW[k] && NOW[k].raw === rawc) return;
    NOW[k] = { artist, title, raw: rawc, ts: Date.now() / 1000, meta: true };
    const h = D.history[k] = D.history[k] || [];
    const last = h[h.length - 1];
    if (last && last.raw === rawc && Date.now() / 1000 - last.ts < 1800) return;
    h.push({ id: String(Date.now()) + Math.floor(Math.random() * 900 + 100), ts: Date.now() / 1000, artist, title, raw: rawc, liked: false, src });
    if (h.length > 5000) h.splice(0, h.length - 5000);
    save();
  }

  /* ---------------------------------------------------------------- Excel χωρίς βιβλιοθήκες */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function zip(files) {
    const enc = new TextEncoder(), parts = [], central = []; let off = 0;
    for (const [name, text] of files) {
      const nb = enc.encode(name), db = enc.encode(text), crc = crc32(db);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, db.length, true); lh.setUint32(22, db.length, true); lh.setUint16(26, nb.length, true);
      parts.push(new Uint8Array(lh.buffer), nb, db);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, db.length, true); ch.setUint32(24, db.length, true); ch.setUint16(28, nb.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), nb);
      off += 30 + nb.length + db.length;
    }
    const csize = central.reduce((a, b) => a + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, csize, true); end.setUint32(16, off, true);
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0)); let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }
  const xe = (s) => String(s ?? "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const col = (i) => { let s = ""; i++; while (i) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
  function xlsx(sheets) {
    const used = new Set(), names = sheets.map(([n]) => { let b = String(n).replace(/[\[\]:*?/\\]/g, " ").slice(0, 31).trim() || "Φύλλο", x = b, k = 2; while (used.has(x.toLowerCase())) x = b.slice(0, 28) + " " + k++; used.add(x.toLowerCase()); return x; });
    const files = [];
    files.push(["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") + "</Types>"]);
    files.push(["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>']);
    files.push(["xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + names.map((n, i) => `<sheet name="${xe(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") + "</sheets></workbook>"]);
    files.push(["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") + `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`]);
    files.push(["xl/styles.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF6B3A1E"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/></cellXfs></styleSheet>']);
    sheets.forEach(([, heads, rows, widths], i) => {
      const cell = (r, j, v, s) => `<c r="${col(j)}${r}" t="inlineStr"${s ? ' s="1"' : ""}><is><t xml:space="preserve">${xe(v)}</t></is></c>`;
      let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>';
      x += widths.map((w, j) => `<col min="${j + 1}" max="${j + 1}" width="${w}" customWidth="1"/>`).join("") + "</cols><sheetData>";
      x += '<row r="1">' + heads.map((h, j) => cell(1, j, h, 1)).join("") + "</row>";
      rows.forEach((row, r) => { x += `<row r="${r + 2}">` + row.map((v, j) => cell(r + 2, j, v)).join("") + "</row>"; });
      x += `</sheetData><autoFilter ref="A1:${col(heads.length - 1)}${Math.max(1, rows.length + 1)}"/></worksheet>`;
      files.push([`xl/worksheets/sheet${i + 1}.xml`, x]);
    });
    return zip(files);
  }
  function b64(u8) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  const pad = (n) => String(n).padStart(2, "0");
  async function exportHistory(keys, likedOnly) {
    const heads = ["Ημερομηνία", "Ώρα", "Καλλιτέχνης", "Τίτλος", "Μου αρέσει", "Σταθμός"], sheets = [];
    for (const k of keys) {
      const st = findSt(k); const name = st ? st.n : k;
      const rows = (D.history[k] || []).filter((h) => !likedOnly || h.liked).map((h) => {
        const t = new Date(h.ts * 1000);
        return [`${pad(t.getDate())}/${pad(t.getMonth() + 1)}/${t.getFullYear()}`, `${pad(t.getHours())}:${pad(t.getMinutes())}`, h.artist || "", h.title || "", h.liked ? "♥" : "", name];
      });
      if (rows.length) sheets.push([name, heads, rows, [12, 7, 32, 40, 11, 26]]);
    }
    if (!sheets.length) return null;
    const label = keys.length === 1 ? ((findSt(keys[0]) || {}).n || "Σταθμός") : "Όλοι οι σταθμοί";
    const t = new Date(); const stamp = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}_${pad(t.getHours())}${pad(t.getMinutes())}`;
    const name = `DjFah Radio - ${label.replace(/[<>:"/\\|?*]+/g, " ")} - ${stamp}.xlsx`;
    await RP.shareFile({ name, base64: b64(xlsx(sheets)), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    return name;
  }

  /* ---------------------------------------------------------------- αναζήτηση νέων */
  async function find(cc, tag, name, hq) {
    const p = { hidebroken: "true", order: "votes", reverse: "true", limit: "120" };
    if (cc) p.countrycode = cc; if (tag) p.tag = tag; if (name) p.name = name;
    const out = [];
    for (const r of await rb("/json/stations/search", p)) {
      const tags = String(r.tags || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
      if (tags.some((t) => NON_MUSIC.has(t))) continue;
      const s = toStream(r); if (hq && !["hq", "unknown"].includes(s.quality)) continue;
      out.push(s);
    }
    return out.sort((a, b) => score(b) - score(a)).slice(0, 60);
  }

  /* ---------------------------------------------------------------- δρομολόγηση όπως στο server.py */
  const summary = () => Object.fromEntries(Object.entries(D.resolved).map(([k, v]) => [k, { quality: v.quality, favicon: v.favicon, any_ok: v.any_ok, n: (v.streams || []).length }]));
  const offlineList = () => Object.keys(D.health).filter(isOffline);
  const fail = (msg, data) => { const e = new Error(msg); e.data = data || {}; throw e; };

  async function call(path, b) {
    const [name, qs] = path.split("?"); const q = Object.fromEntries(new URLSearchParams(qs || ""));
    b = b || {};
    switch (name) {
      case "boot":
        await ready;
        return { version: VERSION, settings: D.settings, favorites: D.favorites, mystations: D.mystations, last: D.last, catalog: CATALOG,
          resolved: summary(), offline: offlineList(), hist_counts: Object.fromEntries(Object.entries(D.history).filter(([, v]) => v.length).map(([k, v]) => [k, v.length])), resolve: RS };
      case "status": return { resolve: RS, resolved: summary(), offline: offlineList() };
      case "resolve": {
        const st = findSt(q.k); if (!st) fail("Δεν βρέθηκε ο σταθμός.");
        try { return await resolve(st, q.force === "1"); } catch (e) { fail(e.message, { offline_net: !navigator.onLine }); }
      }
      case "now": return NOW[q.k] || {};
      case "history": {
        if (q.k === "*") {
          const items = [];
          for (const [k, lst] of Object.entries(D.history)) for (const h of lst) if (h.liked) items.push(Object.assign({}, h, { k, station: (findSt(k) || {}).n || k }));
          return { items: items.sort((a, b) => b.ts - a.ts).slice(0, 2000) };
        }
        return { items: (D.history[q.k] || []).slice(-2000).reverse() };
      }
      case "find": try { return { items: await find(q.cc, q.tag, q.name, q.hq === "1") }; } catch (e) { fail(e.message); }
      case "ping": return { ok: true, app: "DjFah Radio", version: VERSION };
      case "beat": return { ok: true };
      case "fav": { const i = D.favorites.indexOf(b.k); if (i >= 0) D.favorites.splice(i, 1); else D.favorites.push(b.k); save(); return { favorites: D.favorites }; }
      case "like": for (const h of D.history[b.k] || []) if (h.id === b.id) h.liked = !!b.liked; save(); return { ok: true };
      case "like_now": { const l = D.history[b.k] || []; if (!l.length) fail("Δεν υπάρχει τραγούδι για σημείωση."); l[l.length - 1].liked = !l[l.length - 1].liked; save(); return { item: l[l.length - 1] }; }
      case "manual": {
        const raw = `${(b.artist || "").trim()} - ${(b.title || "").trim()}`.replace(/^ - | - $/g, "").trim();
        if (!raw || raw === "-") fail("Γράψε καλλιτέχνη ή τίτλο.");
        delete NOW[b.k]; recordTitle(b.k, raw, "", "manual");
        const l = D.history[b.k] || []; if (l.length && b.liked) l[l.length - 1].liked = true; save(); return { ok: true };
      }
      case "delete_item": D.history[b.k] = (D.history[b.k] || []).filter((h) => h.id !== b.id); save(); return { ok: true };
      case "sent": {
        const first = !D.spotify_lists.includes(b.k); if (first) D.spotify_lists.push(b.k);
        for (const h of D.history[b.k] || []) if (h.id === b.id) h.sent = true; save(); return { first };
      }
      case "health": health(b.k, !!b.ok); return { offline: isOffline(b.k) };
      case "last": D.last = b.k; save(); return { ok: true };
      case "settings": for (const k of ["hq_only", "volume", "catalog_url"]) if (k in b) D.settings[k] = b[k]; save(); return { settings: D.settings };
      case "mystation_add": {
        const s = b.station || {}; if (!s.uuid && !s.url) fail("Λείπει η διεύθυνση του σταθμού.");
        const key = "my:" + (s.uuid || s.url.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(-40));
        const st = { k: key, n: String(s.name || "Σταθμός").trim().slice(0, 80), cc: String(s.cc || "").toUpperCase(), g: s.g || "", hq: false, my: true,
          uuids: s.uuid ? [s.uuid] : [], url: s.uuid ? "" : s.url, favicon: s.favicon || "" };
        D.mystations = D.mystations.filter((m) => m.k !== key).concat(st); delete D.resolved[key]; save();
        try { await resolve(st, true); } catch (e) { }
        return { mystations: D.mystations, k: key };
      }
      case "mystation_remove": D.mystations = D.mystations.filter((m) => m.k !== b.k); D.favorites = D.favorites.filter((k) => k !== b.k); save(); return { mystations: D.mystations };
      case "export": {
        let keys = b.keys || []; if (keys[0] === "*") keys = Object.keys(D.history).filter((k) => D.history[k].length);
        const p = await exportHistory(keys, !!b.liked_only); if (!p) fail("Δεν υπάρχουν τραγούδια για εξαγωγή."); return { path: p };
      }
      case "open_folder": return { ok: false };
      case "open_url": { if (!/^https:\/\//.test(b.url || "")) fail("μη έγκυρη διεύθυνση"); return await RP.openUrl({ url: b.url, app: b.app_uri || "" }); }
      case "catalog_update": { const r = await updateCatalog(); if (r.ok) resolveAll(); return Object.assign(r, { catalog: CATALOG }); }
      case "resolve_all": for (const v of Object.values(D.resolved)) v.t = 0; D.health = {}; save(); resolveAll(); return { ok: true };
      case "recheck": {
        const st = findSt(b.k); if (!st) fail("Δεν βρέθηκε"); delete D.health[b.k];
        try { return await resolve(st, true); } catch (e) { fail(e.message); }
      }
      case "quit": return { ok: true };
    }
    fail("άγνωστη εντολή " + name);
  }

  const ready = loadCatalog().then(() => { resolveAll(); updateCatalog(); });
  window.LocalAPI = { call, recordTitle, native: true };
})();
