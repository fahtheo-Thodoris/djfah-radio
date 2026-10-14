/* DjFah Radio — λογική του παραθύρου */
"use strict";

const $ = (id) => document.getElementById(id);
const IMG = (c) => `/web/img/${c}.webp`;
const audio = $("audio");

const S = {
  catalog: { stations: [], countries: [], genres: {} },
  byKey: {}, countryName: {}, resolved: {}, offline: new Set(), favorites: new Set(),
  my: [], settings: {}, histCounts: {},
  view: "home", list: null, showAll: false,
  cur: null,          // { key, st, streams, idx, hls }
  playing: false, token: 0, tuneList: [],
  now: { raw: null, ts: 0, meta: false }, recent: [], noMetaSince: 0,
  sleepUntil: 0, temp: {}, histKey: null, histItems: [],
};

/* ---------------------------------------------------------------- βοηθητικά */
const NATIVE = !!(window.LocalAPI && window.LocalAPI.native);   // τρέχει ως εφαρμογή Android
const RP = window.RadioPlayer || null;
async function api(path, body) {
  if (window.LocalAPI) return window.LocalAPI.call(path, body);
  const opt = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch("/api/" + path, opt);
  let j = {};
  try { j = await r.json(); } catch (e) { /* κενή απάντηση */ }
  if (!r.ok) { const err = new Error(j.error || `Σφάλμα ${r.status}`); err.data = j; throw err; }
  return j;
}
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
let toastTimer;
function toast(msg, ms = 3200) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
function monogram(name) {
  const w = (name || "").replace(/[()]/g, "").split(/\s+/).filter(Boolean);
  return ((w[0] || "?")[0] + (w[1] ? w[1][0] : "")).toUpperCase();
}
function flag(cc) {
  if (!cc) return el("span", { class: "flag" });
  const i = el("img", { class: "flag", src: `https://flagcdn.com/w40/${cc.toLowerCase()}.png`, alt: "", loading: "lazy" });
  i.onerror = () => { i.style.visibility = "hidden"; };
  return i;
}
function logoEl(st, cls = "st-logo") {
  const box = el("span", { class: cls });
  const fav = (S.resolved[st.k] || {}).favicon || st.favicon;
  if (fav) {
    const i = el("img", { src: fav, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
    i.onerror = () => { box.textContent = monogram(st.n); };
    box.append(i);
  } else box.textContent = monogram(st.n);
  return box;
}
function qualityLabel(st) {
  const r = S.resolved[st.k];
  if (!r) return { cls: "std", text: "έλεγχος…", hq: false };
  if (r.quality === "hq") return { cls: "", text: "HQ", hq: true };
  if (r.quality === "unknown") return { cls: "std", text: "ροή", hq: false };
  if (r.quality === "none") return { cls: "std", text: "δεν βρέθηκε", hq: false };
  return { cls: "std", text: r.quality === "std" ? "τυπική" : "χαμηλή", hq: false };
}
function fmtTime(ts) { return new Date(ts * 1000).toLocaleTimeString("el-GR", { hour: "2-digit", minute: "2-digit", hour12: false }); }
function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }
function fmtDate(ts) { return new Date(ts * 1000).toLocaleDateString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric" }); }
function genreName(g) { return S.catalog.genres[g] || g || ""; }
function allStations() { return S.catalog.stations.concat(S.my); }
function getSt(k) { return S.byKey[k] || S.temp[k] || null; }

/* ποιοι σταθμοί φαίνονται με τα τωρινά κριτήρια */
function passes(st) {
  if (S.offline.has(st.k)) return false;
  const r = S.resolved[st.k];
  if (r && r.quality === "none") return false;
  if (!S.settings.hq_only || S.showAll || st.my) return true;
  if (!r) return true;                      // δεν έχει ελεγχθεί ακόμα
  return r.quality === "hq" || r.quality === "unknown";
}

/* ---------------------------------------------------------------- εκκίνηση */
async function boot() {
  const started = Date.now();
  let b;
  try { b = await api("boot"); }
  catch (e) { $("splashSub").textContent = "Η εφαρμογή δεν απαντά. Κλείσε και άνοιξέ τη ξανά."; return; }
  applyBoot(b);
  $("ver").textContent = "έκδοση " + b.version;
  audio.volume = Number(S.settings.volume ?? 0.8);
  $("vol").value = audio.volume;
  setKnob("knobVol", -135 + audio.volume * 270);
  renderHome(); renderSettings(); updateResolveStatus(b.resolve);
  const wait = Math.max(0, 1500 - (Date.now() - started));
  setTimeout(() => $("splash").classList.add("done"), wait);
  S.lastKey = b.last;
  if (b.last && getSt(b.last)) setCurrent(b.last, false);
  setInterval(() => api("beat", {}).catch(() => {}), 10000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { api("beat", {}).catch(() => {}); if (S.view === "player") renderRecent(); } });
  if (NATIVE) syncNative();
  setTimeout(() => checkUpdate(b.version), 4000);
  api("beat", {}).catch(() => {});
  setInterval(pollStatus, 6000);
  setInterval(pollNow, 3500);
  setInterval(tickSleep, 1000);
  if (!navigator.onLine) showOffline(true);
}
function applyBoot(b) {
  S.catalog = b.catalog; S.settings = b.settings; S.my = b.mystations || [];
  S.favorites = new Set(b.favorites || []); S.resolved = b.resolved || {};
  S.offline = new Set(b.offline || []); S.histCounts = b.hist_counts || {};
  indexStations();
}
function indexStations() {
  S.byKey = {}; for (const s of allStations()) S.byKey[s.k] = s;
  S.countryName = {}; for (const c of S.catalog.countries) S.countryName[c.cc] = c.name;
}
let lastResolveDone = -1;
/* ---------------------------------------------------------------- νέα έκδοση */
const VERSION_URL = "https://raw.githubusercontent.com/fahtheo-Thodoris/djfah-radio/main/version.json";
function newer(a, b) {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}
async function checkUpdate(current) {
  try {
    const v = await (await fetch(VERSION_URL + "?t=" + Date.now(), { cache: "no-store" })).json();
    if (!v.version || !newer(v.version, current)) return;
    const url = NATIVE ? v.apk : v.bat;
    if (!url) return;
    const bar = el("div", { class: "update-bar", role: "status" },
      el("span", { text: `Υπάρχει νέα έκδοση ${v.version}` + (v.notes ? ` · ${v.notes}` : "") }),
      el("button", { class: "btn small", text: NATIVE ? "Λήψη και εγκατάσταση" : "Λήψη", onclick: () => {
        api("open_url", { url }).catch(() => {});
        toast(NATIVE ? "Όταν κατέβει, άνοιξε το αρχείο και πάτα «Εγκατάσταση»· τα δεδομένα σου μένουν." : "Όταν κατέβει, κάνε διπλό κλικ στο αρχείο· τα δεδομένα σου μένουν.", 7000);
      } }),
      el("button", { class: "link", text: "Αργότερα", onclick: () => bar.remove() }));
    $("main").prepend(bar);
  } catch (e) { /* χωρίς σύνδεση ή χωρίς αρχείο έκδοσης */ }
}
async function pollStatus() {
  try {
    const s = await api("status");
    S.resolved = s.resolved; S.offline = new Set(s.offline);
    updateResolveStatus(s.resolve);
    if (s.resolve.running && s.resolve.done !== lastResolveDone && S.view === "home") {
      lastResolveDone = s.resolve.done;
      if (S.list) renderList(); else renderHomeCounts();
    }
  } catch (e) { /* ήσυχα */ }
}
function updateResolveStatus(r) {
  $("resolveStatus").textContent = r && r.running && r.total
    ? `Έλεγχος ποιότητας σταθμών: ${r.done} / ${r.total}` : `${allStations().length} σταθμοί · έτοιμοι`;
}

/* ---------------------------------------------------------------- πλοήγηση */
const viewStack = [];
function show(view, fromBack) {
  if (!fromBack && S.view && S.view !== view) { viewStack.push(S.view); if (viewStack.length > 20) viewStack.shift(); }
  S.view = view;
  for (const v of ["home", "player", "favs", "history", "find", "settings"]) {
    $("view-" + v).hidden = v !== view;
    $("nav-" + v).classList.toggle("active", v === view);
  }
  $("main").scrollTop = 0;
  if (view === "favs") renderFavs();
  if (view === "history") openHistory(S.histKey || (S.cur && S.cur.key) || "*");
  if (view === "find") initFind();
  if (view === "player") renderRecent();
}
document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

/* ---------------------------------------------------------------- αρχική */
function renderHome() {
  const genres = $("genres"); genres.textContent = "";
  for (const [g, name] of Object.entries(S.catalog.genres)) {
    const card = el("button", { class: "genre", onclick: () => openList({ type: "genre", value: g, title: name }) },
      el("img", { src: IMG(genreImg(g)), alt: "", loading: "lazy" }),
      el("span", {}, name, el("small", { "data-g": g })));
    genres.append(card);
  }
  const cs = $("countries"); cs.textContent = "";
  for (const c of S.catalog.countries) {
    cs.append(el("button", { class: "country", onclick: () => openList({ type: "country", value: c.cc, title: c.name }) },
      flag(c.cc), el("b", { text: c.name }), el("i", { "data-cc": c.cc })));
  }
  $("statCount").textContent = S.catalog.stations.length;
  $("countryCount").textContent = S.catalog.countries.length;
  renderHomeCounts(); renderMy();
}
const GENRE_IMG = { K: "DR-10", J: "DR-11", A: "DR-12", I: "DR-13", C: "DR-14", E: "DR-15", W: "DR-16", F: "DR-17", R: "DR-18", S: "DR-19", X: "DR-20" };
function genreImg(g) { return GENRE_IMG[g] || "DR-20"; }
function renderHomeCounts() {
  const vis = allStations().filter(passes);
  document.querySelectorAll("[data-g]").forEach((n) => {
    const c = vis.filter((s) => s.g === n.dataset.g).length; n.textContent = plural(c, "σταθμός", "σταθμοί");
  });
  document.querySelectorAll("[data-cc]").forEach((n) => { n.textContent = vis.filter((s) => s.cc === n.dataset.cc).length; });
}
function renderMy() {
  $("myBlock").hidden = !S.my.length;
  const box = $("myList"); box.textContent = "";
  for (const s of S.my) box.append(stationRow(s, { removable: true }));
}
$("q").addEventListener("input", () => {
  const v = $("q").value.trim();
  if (v.length >= 2) openList({ type: "search", value: v, title: `Αναζήτηση: «${v}»` });
  else if (!v && S.list && S.list.type === "search") closeList();
});
$("listBack").addEventListener("click", closeList);
function openList(spec) { S.list = spec; S.showAll = false; renderList(); $("homeBrowse").hidden = true; $("homeList").hidden = false; }
function closeList() { S.list = null; S.showAll = false; $("homeBrowse").hidden = false; $("homeList").hidden = true; $("q").value = ""; renderHomeCounts(); }
function norm(s) { return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
function listStations(spec) {
  const all = allStations();
  if (spec.type === "genre") return all.filter((s) => s.g === spec.value);
  if (spec.type === "country") return all.filter((s) => s.cc === spec.value);
  const q = norm(spec.value);
  return all.filter((s) => norm(s.n).includes(q) || norm(S.countryName[s.cc]).includes(q) || norm(genreName(s.g)).includes(q));
}
function renderList() {
  const spec = S.list; if (!spec) return;
  const all = listStations(spec);
  const vis = all.filter(passes);
  const dead = all.filter((s) => S.offline.has(s.k));
  const hidden = all.length - vis.length - dead.length;
  $("listTitle").textContent = spec.title;
  $("listSub").textContent = plural(vis.length, "σταθμός", "σταθμοί") + (spec.type === "country" ? " · επιλεγμένοι για τη μουσική τους" : "");
  const box = $("stationList"); box.textContent = "";
  vis.forEach((s) => box.append(stationRow(s)));
  if (!vis.length) box.append(el("p", { class: "muted", text: "Δεν υπάρχουν σταθμοί εδώ με τα τωρινά κριτήρια." }));
  S.tuneList = vis.map((s) => s.k);
  const note = $("hiddenNote");
  if (hidden > 0 && !S.showAll) {
    note.hidden = false; note.textContent = `${hidden} σταθμοί κρύφτηκαν, γιατί η ροή τους δεν φτάνει την υψηλή ποιότητα ή δεν βρέθηκε. `;
    note.append(el("button", { text: "Δείξε τους", onclick: () => { S.showAll = true; renderList(); } }));
  } else note.hidden = true;
  $("offlineBlock").hidden = !dead.length; $("offlineCount").textContent = dead.length;
  const ob = $("offlineList"); ob.textContent = "";
  dead.forEach((s) => ob.append(stationRow(s, { dead: true })));
}

/* μία γραμμή σταθμού */
function stationRow(st, opt = {}) {
  const q = qualityLabel(st);
  const isFav = S.favorites.has(st.k);
  const row = el("div", { class: "st" + (S.cur && S.cur.key === st.k ? " playing" : "") + (opt.dead ? " dead" : ""), "data-k": st.k });
  const main = el("button", { class: "st-main", onclick: () => { play(st.k); show("player"); }, "aria-label": `Άκουσε ${st.n}` },
    el("span", { class: "st-name", text: st.n }),
    el("span", { class: "st-sub" }, flag(st.cc), S.countryName[st.cc] || st.cc || "", st.g ? el("span", { class: "chip std", text: genreName(st.g) }) : null,
      S.histCounts[st.k] ? el("span", { text: "· " + plural(S.histCounts[st.k], "τραγούδι", "τραγούδια") }) : null));
  const badge = el("span", { class: "q-badge", title: "Ποιότητα ροής" }, q.hq ? el("img", { src: IMG("DR-41"), alt: "Υψηλή ποιότητα" }) : null, el("span", { class: "chip " + q.cls, text: q.text }));
  const fav = el("button", { class: "icon-btn" + (isFav ? "" : " off"), "aria-label": isFav ? "Αφαίρεση από αγαπημένους" : "Προσθήκη στους αγαπημένους", onclick: (e) => { e.stopPropagation(); toggleFav(st.k); } },
    el("img", { src: IMG("DR-44"), alt: "" }));
  let last;
  if (opt.dead) last = el("button", { class: "btn ghost", text: "Δοκίμασε ξανά", onclick: () => recheck(st.k) });
  else if (opt.removable) last = el("button", { class: "btn ghost", text: "Αφαίρεση", onclick: () => removeMy(st.k) });
  else last = el("button", { class: "icon-btn", "aria-label": `Άκουσε ${st.n}`, onclick: () => { play(st.k); show("player"); } }, el("img", { src: IMG("DR-30"), alt: "" }));
  row.append(logoEl(st), main, badge, fav, last);
  return row;
}
async function toggleFav(k) {
  const r = await api("fav", { k });
  S.favorites = new Set(r.favorites);
  document.querySelectorAll(`.st[data-k="${CSS.escape(k)}"] .icon-btn[aria-label*="αγαπημένους"]`).forEach((b) => {
    const on = S.favorites.has(k); b.classList.toggle("off", !on);
    b.setAttribute("aria-label", on ? "Αφαίρεση από αγαπημένους" : "Προσθήκη στους αγαπημένους");
  });
  updateFavStationBtn();
  if (S.view === "favs") renderFavs();
  toast(S.favorites.has(k) ? "Μπήκε στους αγαπημένους σταθμούς" : "Βγήκε από τους αγαπημένους");
}
async function recheck(k) {
  toast("Ελέγχω ξανά τον σταθμό…");
  try { await api("recheck", { k }); S.offline.delete(k); await pollStatus(); renderList(); toast("Ο σταθμός ελέγχθηκε ξανά."); }
  catch (e) { toast(e.message); }
}
async function removeMy(k) {
  const r = await api("mystation_remove", { k });
  S.my = r.mystations; indexStations(); renderMy(); toast("Ο σταθμός αφαιρέθηκε.");
}

/* ---------------------------------------------------------------- αγαπημένοι */
function renderFavs() {
  const box = $("favList"); box.textContent = "";
  const favs = [...S.favorites].map(getSt).filter(Boolean);
  favs.forEach((s) => box.append(stationRow(s)));
  $("favEmpty").hidden = favs.length > 0;
  if (favs.length) S.tuneList = favs.map((s) => s.k);
}

/* ---------------------------------------------------------------- αναπαραγωγή */
let hls = null;
function setCurrent(key, fromPlay = true) {
  const st = getSt(key); if (!st) return;
  S.cur = { key, st, streams: (S.temp[key] && S.temp[key].streams) || null, idx: 0, hls: false };
  if (!S.tuneList.includes(key)) S.tuneList = S.tuneList.length ? S.tuneList : allStations().filter(passes).map((s) => s.k);
  const country = S.countryName[st.cc] || st.cc || "";
  $("dialTop").textContent = [country, genreName(st.g)].filter(Boolean).join(" · ") || "DjFah Radio";
  $("dialName").textContent = st.n;
  $("dialBottom").textContent = " ";
  moveNeedle();
  const lab = $("vinylLabel"); lab.textContent = "";
  const fav = (S.resolved[key] || {}).favicon || st.favicon;
  if (fav) { const i = el("img", { src: fav, alt: "", referrerpolicy: "no-referrer" }); i.onerror = () => { lab.textContent = ""; lab.append(el("span", { text: monogram(st.n) })); }; lab.append(i); }
  else lab.append(el("span", { text: monogram(st.n) }));
  $("bar").hidden = false;
  $("barName").textContent = st.n; $("barSong").textContent = country;
  const bl = $("barLogo"); bl.textContent = "";
  if (fav) { const i = el("img", { src: fav, alt: "", referrerpolicy: "no-referrer" }); i.onerror = () => i.remove(); bl.append(i); }
  S.now = { raw: null, ts: 0, meta: false }; S.noMetaSince = Date.now();
  setNowText("", fromPlay ? "Συντονισμός…" : "Πάτα αναπαραγωγή για να ξεκινήσει", fromPlay ? "Συντονισμός" : "Σε αναμονή");
  $("noTitles").hidden = true; $("qualityRow").textContent = "";
  updateFavStationBtn(); updateLikeBtn(null);
  document.querySelectorAll(".st.playing").forEach((n) => n.classList.remove("playing"));
  document.querySelectorAll(`.st[data-k="${CSS.escape(key)}"]`).forEach((n) => n.classList.add("playing"));
  renderRecent();
}
function moveNeedle() {
  const n = S.tuneList.length, i = S.cur ? S.tuneList.indexOf(S.cur.key) : -1;
  const pos = n > 1 && i >= 0 ? 7 + (86 * i) / (n - 1) : 50;
  $("needle").style.left = pos + "%";
}
function setNowText(artist, title, state) {
  $("nowArtist").textContent = artist || " ";
  $("nowTitle").textContent = title;
  $("nowState").textContent = state;
}
function setPlayingUI(on) {
  S.playing = on;
  document.body.classList.toggle("playing-on", on);
  for (const id of ["btnPlay", "barPlay"]) {
    const b = $(id); b.querySelector("img").src = IMG(on ? "DR-31" : "DR-30");
    b.setAttribute("aria-label", on ? "Παύση" : "Αναπαραγωγή");
  }
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = on ? "playing" : "paused";
}
function stopAudio() {
  if (NATIVE) { nativeWait = null; RP.stop().catch(() => {}); return; }
  if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
  audio.pause(); audio.removeAttribute("src"); audio.load();
}
async function play(key) {
  const token = ++S.token;
  if (!S.cur || S.cur.key !== key) setCurrent(key, true);
  else setNowText("", "Συντονισμός…", "Συντονισμός");
  stopAudio(); setPlayingUI(false);
  if (S.view !== "player" && S.view !== "home" && S.view !== "favs") { /* μένει όπου είναι */ }
  let streams = S.cur.streams;
  if (!streams) {
    try { const info = await api("resolve?k=" + encodeURIComponent(key)); streams = info.streams || []; S.resolved[key] = { quality: info.quality, favicon: info.favicon, any_ok: info.any_ok }; }
    catch (e) {
      if (token !== S.token) return;
      if (!navigator.onLine || (e.data && e.data.offline_net)) { showOffline(true); }
      setNowText("", "Η βάση σταθμών δεν απαντά αυτή τη στιγμή. Δοκίμασε ξανά σε λίγο.", "Πρόβλημα σύνδεσης");
      return;
    }
    S.cur.streams = streams;
  }
  if (token !== S.token) return;
  if (!streams.length) { setNowText("", "Δεν βρέθηκε ροή για αυτόν τον σταθμό.", "Μη διαθέσιμος"); api("health", { k: key, ok: false }).catch(() => {}); return; }
  for (let i = 0; i < streams.length; i++) {
    if (token !== S.token) return;
    try {
      await playStream(streams[i], key, token);
      if (token !== S.token) return;
      S.cur.idx = i; S.cur.hls = !!streams[i].hls;
      onStarted(streams[i]);
      return;
    } catch (e) { console.warn("stream failed", streams[i].url, e); stopAudio(); }
  }
  if (token !== S.token) return;
  setNowText("", "Ο σταθμός δεν απαντά τώρα. Δοκίμασε άλλον ή ξανά αργότερα.", "Δεν απαντά");
  api("health", { k: key, ok: false }).then((r) => { if (r.offline) { S.offline.add(key); toast("Ο σταθμός δεν απαντά εδώ και τρεις μέρες· μπήκε στους «Εκτός λειτουργίας»."); } }).catch(() => {});
}
let nativeWait = null;
function playStream(s, key, token) {
  if (NATIVE) return new Promise((resolve, reject) => {
    const st = getSt(key) || { n: "DjFah Radio" };
    const t = setTimeout(() => { if (nativeWait) { nativeWait = null; reject(new Error("timeout")); } }, 15000);
    nativeWait = { resolve: () => { clearTimeout(t); resolve(); }, reject: (e) => { clearTimeout(t); reject(e); } };
    RP.play({ url: s.url, station: st.n, subtitle: [S.countryName[st.cc], genreName(st.g)].filter(Boolean).join(" · ") || "DjFah Radio",
      artwork: (S.resolved[key] || {}).favicon || s.favicon || "" })
      .catch((e) => { if (nativeWait) { const w = nativeWait; nativeWait = null; w.reject(e); } });
  });
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (ok, err) => { if (done) return; done = true; clearTimeout(timer); audio.removeEventListener("playing", onPlay); audio.removeEventListener("error", onErr); ok ? resolve() : reject(err); };
    const onPlay = () => finish(true);
    const onErr = () => finish(false, new Error("audio error"));
    const timer = setTimeout(() => finish(false, new Error("timeout")), 15000);
    audio.addEventListener("playing", onPlay); audio.addEventListener("error", onErr);
    if (s.hls) {
      if (window.Hls && Hls.isSupported()) {
        hls = new Hls({ lowLatencyMode: false, maxBufferLength: 30 });
        hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) finish(false, new Error("hls " + d.details)); });
        hls.loadSource(s.url); hls.attachMedia(audio);
        hls.on(Hls.Events.MANIFEST_PARSED, () => audio.play().catch((e) => finish(false, e)));
      } else if (audio.canPlayType("application/vnd.apple.mpegurl")) {
        audio.src = s.url; audio.play().catch((e) => finish(false, e));
      } else finish(false, new Error("no hls"));
    } else {
      audio.src = "/stream?k=" + encodeURIComponent(key) + "&u=" + encodeURIComponent(s.url);
      audio.play().catch((e) => finish(false, e));
    }
  });
}
function onStarted(s) {
  setPlayingUI(true);
  const st = S.cur.st;
  setNowText("", S.now.title || "Ακούς ζωντανά", "Ζωντανά");
  const q = s.quality === "hq";
  const codec = (s.codec || (s.hls ? "HLS" : "")).toUpperCase();
  const parts = [codec, s.bitrate ? `${s.bitrate} kbps` : ""].filter(Boolean).join(" · ");
  $("dialBottom").textContent = parts || " ";
  const qr = $("qualityRow"); qr.textContent = "";
  if (q) qr.append(el("img", { src: IMG("DR-41"), alt: "" }), el("span", { text: "Υψηλή ποιότητα" }));
  if (parts) qr.append(el("span", { text: parts }));
  if (S.cur.streams.length > 1) qr.append(el("span", { text: `· ροή ${S.cur.idx + 1} από ${S.cur.streams.length}` }));
  if (!st.k.startsWith("tmp:")) { api("health", { k: st.k, ok: true }).catch(() => {}); api("last", { k: st.k }).catch(() => {}); S.offline.delete(st.k); }
  S.noMetaSince = Date.now();
  mediaSession();
  pollNow();
}
function togglePlay() {
  if (!S.cur) { const first = S.tuneList[0] || (allStations().find(passes) || {}).k; if (first) play(first); return; }
  if (S.playing) { S.token++; stopAudio(); setPlayingUI(false); $("nowState").textContent = "Σε παύση"; }
  else play(S.cur.key);
}
$("btnPlay").addEventListener("click", togglePlay);
$("barPlay").addEventListener("click", togglePlay);
$("barStation").addEventListener("click", () => show("player"));

/* αποσύνδεση στη μέση: ξαναπροσπάθεια και μετά επόμενη ροή */
let stallTimer = null;
audio.addEventListener("waiting", () => {
  if (!S.playing) return;
  clearTimeout(stallTimer);
  stallTimer = setTimeout(() => { if (S.playing && audio.readyState < 3) { toast("Η ροή κόλλησε· ξανασυνδέομαι…"); reconnect(); } }, 12000);
});
audio.addEventListener("playing", () => clearTimeout(stallTimer));
audio.addEventListener("error", () => { if (S.playing) { toast("Η ροή διακόπηκε· ξανασυνδέομαι…"); reconnect(); } });
audio.addEventListener("ended", () => { if (S.playing) reconnect(); });
let reconnects = 0;
async function reconnect() {
  if (!S.cur) return;
  const token = ++S.token; const key = S.cur.key; const streams = S.cur.streams || [];
  stopAudio();
  reconnects++;
  const order = [S.cur.idx, ...streams.map((_, i) => i).filter((i) => i !== S.cur.idx)];
  for (const i of order) {
    if (token !== S.token) return;
    try { await playStream(streams[i], key, token); S.cur.idx = i; reconnects = 0; onStarted(streams[i]); return; } catch (e) { stopAudio(); }
  }
  setPlayingUI(false); setNowText("", "Η σύνδεση με τον σταθμό χάθηκε. Πάτα αναπαραγωγή για νέα προσπάθεια.", "Διακοπή");
}

/* ---------------------------------------------------------------- τι παίζει */
async function pollNow() {
  if (!S.cur || !S.playing) return;
  const key = S.cur.key;
  let n = {};
  if (!S.cur.hls) { try { n = await api("now?k=" + encodeURIComponent(key)); } catch (e) { return; } }
  if (!S.cur || S.cur.key !== key) return;
  if (n.title || n.artist) {
    S.noMetaSince = 0;
    $("noTitles").hidden = true;
    if (n.raw !== S.now.raw) {
      S.now = { raw: n.raw, ts: n.ts, meta: true, title: n.title, artist: n.artist };
      setNowText(n.artist, n.title, "Ζωντανά · τώρα παίζει");
      $("barSong").textContent = [n.artist, n.title].filter(Boolean).join(" — ");
      mediaSession(); renderRecent();
    }
  } else {
    if (!S.noMetaSince) S.noMetaSince = Date.now();
    if (Date.now() - S.noMetaSince > 25000) {
      $("noTitles").hidden = false;
      if (!S.now.meta) setNowText("", "Ακούς ζωντανά", "Ζωντανά · ο σταθμός δεν στέλνει τίτλους");
    }
  }
}
async function renderRecent() {
  const ul = $("recentList"); if (!ul) return;
  if (!S.cur) { ul.textContent = ""; ul.append(el("li", {}, el("span", { class: "empty-line", text: "Διάλεξε σταθμό και τα τραγούδια θα γράφονται εδώ." }))); return; }
  let items = [];
  try { items = (await api("history?k=" + encodeURIComponent(S.cur.key))).items || []; } catch (e) { return; }
  S.recent = items;
  S.histCounts[S.cur.key] = items.length;
  updateLikeBtn(items[0] || null);
  ul.textContent = "";
  if (!items.length) { ul.append(el("li", {}, el("span", { class: "empty-line", text: "Δεν έχει καταγραφεί τραγούδι ακόμα." }))); return; }
  for (const h of items.slice(0, 7)) ul.append(songLi(h, S.cur.key));
}
function songLi(h, key) {
  const like = el("button", { class: "icon-btn", "aria-label": h.liked ? "Δεν μου αρέσει πια" : "Μου αρέσει", onclick: async () => {
    h.liked = !h.liked; await api("like", { k: key, id: h.id, liked: h.liked }); renderRecent(); } },
    el("img", { src: IMG(h.liked ? "DR-33" : "DR-32"), alt: "" }));
  const sp = listBtn(h, key, renderRecent);
  return el("li", {}, el("time", { text: fmtTime(h.ts) }),
    el("span", { class: "song", title: h.raw }, h.artist ? el("b", { text: h.artist + " — " }) : null, h.title ), like, sp);
}
function updateLikeBtn(item) {
  const liked = item && item.liked;
  for (const id of ["btnLike", "barLike"]) {
    $(id).querySelector("img").src = IMG(liked ? "DR-33" : "DR-32");
    $(id).classList.toggle("off", !item);
  }
}
async function likeNow() {
  if (!S.cur) return;
  try { const r = await api("like_now", { k: S.cur.key }); toast(r.item.liked ? `♥ ${r.item.artist ? r.item.artist + " — " : ""}${r.item.title}` : "Αφαιρέθηκε από όσα σου αρέσουν"); renderRecent(); }
  catch (e) { toast("Δεν υπάρχει ακόμα τραγούδι για να σημειώσεις. Αν ο σταθμός δεν στέλνει τίτλους, γράψ' το με το χέρι."); }
}
$("btnLike").addEventListener("click", likeNow);
$("barLike").addEventListener("click", likeNow);
$("btnSpotify").addEventListener("click", () => {
  const h = S.recent[0];
  if (S.cur && h && h.title) addToStationList(h, S.cur.key, renderRecent);
  else toast("Δεν υπάρχει ακόμα τραγούδι. Αν ο σταθμός δεν στέλνει τίτλους, γράψ' το με το χέρι.");
});
$("btnHistory").addEventListener("click", () => { if (S.cur) S.histKey = S.cur.key; show("history"); });
$("recentAll").addEventListener("click", () => { if (S.cur) S.histKey = S.cur.key; show("history"); });
$("btnFavStation").addEventListener("click", () => S.cur && toggleFav(S.cur.key));
function updateFavStationBtn() { $("btnFavStation").classList.toggle("off", !(S.cur && S.favorites.has(S.cur.key))); }
$("manualForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!S.cur) return;
  const artist = $("manArtist").value.trim(), title = $("manTitle").value.trim();
  if (!artist && !title) { toast("Γράψε καλλιτέχνη ή τίτλο."); return; }
  await api("manual", { k: S.cur.key, artist, title, liked: true });
  $("manArtist").value = ""; $("manTitle").value = "";
  setNowText(artist, title, "Προστέθηκε με το χέρι");
  toast("Το τραγούδι μπήκε στο αρχείο του σταθμού με ♥"); renderRecent();
});

function openSpotify(artist, title) {
  const q = [artist, title].filter(Boolean).join(" ").trim();
  if (!q) return Promise.resolve();
  return api("open_url", { url: "https://open.spotify.com/search/" + encodeURIComponent(q), app_uri: "spotify:search:" + encodeURIComponent(q) });
}
function listName(key) { return "DjFah Radio · " + ((getSt(key) || {}).n || ""); }
async function copyText(t) {
  if (NATIVE) { try { await RP.copy({ text: t }); return true; } catch (e) { return false; } }
  try { await navigator.clipboard.writeText(t); return true; }
  catch (e) { const ta = el("textarea"); ta.value = t; document.body.append(ta); ta.select(); const ok = document.execCommand("copy"); ta.remove(); return ok; }
}
function listBtn(h, key, after) {
  return el("button", { class: "btn ghost small" + (h.sent ? " done" : ""), title: h.sent ? "Είναι ήδη στη λίστα του σταθμού· πάτα για να το ξαναστείλεις" : "Άνοιγμα στο Spotify για τη λίστα του σταθμού",
    onclick: () => addToStationList(h, key, after) },
    el("img", { src: IMG("DR-38"), alt: "" }), el("span", { text: h.sent ? "Στη λίστα ✓" : "Στη λίστα Spotify" }));
}
/* Ένα τραγούδι στη λίστα «DjFah Radio · Σταθμός», χωρίς λογαριασμό developer.
   Η εφαρμογή αντιγράφει το όνομα της λίστας και ανοίγει το τραγούδι στο Spotify·
   ο χρήστης πατάει «Προσθήκη σε λίστα». Την πρώτη φορά φτιάχνει τη λίστα με αυτό το όνομα. */
async function addToStationList(h, key, after) {
  const name = listName(key);
  await copyText(name);
  try { await openSpotify(h.artist, h.title); } catch (e) { toast(e.message); return; }
  let r = { first: false };
  try { r = await api("sent", { k: key, id: h.id }); } catch (e) { /* συνεχίζουμε */ }
  h.sent = true;
  if (after) after();
  if (r.first) {
    openModal("Πρώτο τραγούδι σε αυτή τη λίστα", [
      el("p", {}, "Άνοιξε το Spotify με το τραγούδι. Επειδή είναι το πρώτο από αυτόν τον σταθμό, φτιάξε τώρα τη λίστα του:"),
      el("ol", {},
        el("li", { text: "Πάτα το σωστό τραγούδι στα αποτελέσματα." }),
        el("li", { text: "Πάτα τις τρεις τελείες ⋯ και μετά «Προσθήκη σε λίστα»." }),
        el("li", { text: "Πάτα «Νέα λίστα» και κάνε επικόλληση (Ctrl+V) το όνομα:" })),
      el("p", { class: "pl-name", text: name }),
      el("p", { class: "muted", text: "Το όνομα έχει ήδη αντιγραφεί. Από την επόμενη φορά απλώς διαλέγεις αυτή τη λίστα." })],
      [el("button", { class: "btn ghost", text: "Αντιγραφή ξανά", onclick: () => copyText(name).then(() => toast("Αντιγράφηκε")) }),
       el("button", { class: "btn", text: "Εντάξει", onclick: closeModal })]);
  } else {
    toast(`Στο Spotify: ⋯ → «Προσθήκη σε λίστα» → «${name}»`, 6000);
  }
}

function mediaSession() {
  if (NATIVE) { if (S.cur && S.now.title) RP.setNowPlaying({ title: S.now.title, artist: S.now.artist || S.cur.st.n }).catch(() => {}); return; }
  if (!("mediaSession" in navigator) || !S.cur) return;
  const st = S.cur.st; const fav = (S.resolved[st.k] || {}).favicon || st.favicon;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: S.now.title || st.n, artist: S.now.artist || st.n, album: "DjFah Radio · " + st.n, artwork: fav ? [{ src: fav, sizes: "256x256" }] : [{ src: "/web/img/icon-512.png", sizes: "512x512" }] });
    navigator.mediaSession.setActionHandler("play", togglePlay);
    navigator.mediaSession.setActionHandler("pause", togglePlay);
    navigator.mediaSession.setActionHandler("nexttrack", () => tune(1));
    navigator.mediaSession.setActionHandler("previoustrack", () => tune(-1));
  } catch (e) { /* παλιό πρόγραμμα περιήγησης */ }
}

/* ---------------------------------------------------------------- πόμολα */
function setKnob(id, deg) { $(id).querySelector("img").style.transform = `rotate(${deg}deg)`; }
function setVolume(v, save = true) {
  v = Math.max(0, Math.min(1, v)); audio.volume = v; if (NATIVE) RP.setVolume({ volume: v }).catch(() => {}); $("vol").value = v; setKnob("knobVol", -135 + v * 270);
  if (save) { clearTimeout(setVolume.t); setVolume.t = setTimeout(() => api("settings", { volume: v }).catch(() => {}), 600); }
}
$("vol").addEventListener("input", () => setVolume(Number($("vol").value)));
$("knobVol").addEventListener("wheel", (e) => { e.preventDefault(); setVolume(audio.volume + (e.deltaY < 0 ? 0.05 : -0.05)); }, { passive: false });
$("knobVol").addEventListener("click", () => setVolume(audio.volume > 0 ? 0 : 0.7));
(function dragKnob() {
  let y0 = null, v0 = 0;
  $("knobVol").addEventListener("pointerdown", (e) => { y0 = e.clientY; v0 = audio.volume; $("knobVol").setPointerCapture(e.pointerId); });
  $("knobVol").addEventListener("pointermove", (e) => { if (y0 !== null) setVolume(v0 + (y0 - e.clientY) / 160); });
  $("knobVol").addEventListener("pointerup", () => { y0 = null; });
})();
let tuneDeg = 0, tuneTimer = null;
function tune(dir) {
  if (!S.tuneList.length) return;
  const i = S.cur ? S.tuneList.indexOf(S.cur.key) : -1;
  const next = S.tuneList[(i + dir + S.tuneList.length) % S.tuneList.length];
  tuneDeg += dir * 24; setKnob("knobTune", tuneDeg);
  setCurrent(next, true);
  clearTimeout(tuneTimer); tuneTimer = setTimeout(() => play(next), 650);   // περιμένει να σταματήσεις να γυρίζεις
}
$("knobTune").addEventListener("click", (e) => tune(e.shiftKey ? -1 : 1));
$("knobTune").addEventListener("contextmenu", (e) => { e.preventDefault(); tune(-1); });
$("knobTune").addEventListener("wheel", (e) => { e.preventDefault(); tune(e.deltaY < 0 ? -1 : 1); }, { passive: false });
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input,select,textarea")) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  if (e.key === "ArrowRight" && S.view === "player") tune(1);
  if (e.key === "ArrowLeft" && S.view === "player") tune(-1);
});

/* ---------------------------------------------------------------- χρονοδιακόπτης */
$("btnSleep").addEventListener("click", () => {
  const box = el("div", { class: "sleep-opts" });
  for (const m of [15, 30, 45, 60, 90]) box.append(el("button", { class: "btn ghost", text: `${m} λεπτά`, onclick: () => { S.sleepUntil = Date.now() + m * 60000; closeModal(); toast(`Η μουσική θα σβήσει σε ${m} λεπτά.`); } }));
  if (S.sleepUntil) box.append(el("button", { class: "btn ghost", text: "Ακύρωση", onclick: () => { S.sleepUntil = 0; closeModal(); tickSleep(); toast("Ο χρονοδιακόπτης ακυρώθηκε."); } }));
  openModal("Χρονοδιακόπτης ύπνου", [el("p", { class: "muted", text: "Η μουσική θα χαμηλώσει σιγά σιγά και θα σταματήσει." }), box], []);
});
let fading = false;
function tickSleep() {
  const left = S.sleepUntil ? S.sleepUntil - Date.now() : 0;
  $("sleepLeft").textContent = S.sleepUntil ? Math.max(1, Math.ceil(left / 60000)) + "′" : "";
  if (S.sleepUntil && left <= 20000 && !fading && S.playing) {
    fading = true; const v0 = audio.volume; const t0 = Date.now();
    const f = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / 20000); audio.volume = v0 * (1 - p);
      if (p >= 1 || !S.sleepUntil) { clearInterval(f); if (S.sleepUntil) { S.token++; stopAudio(); setPlayingUI(false); $("nowState").textContent = "Καληνύχτα"; } audio.volume = v0; S.sleepUntil = 0; fading = false; tickSleep(); }
    }, 250);
  }
}

/* ---------------------------------------------------------------- τραγούδια */
async function openHistory(key) {
  S.histKey = key;
  const sel = $("histStation"); sel.textContent = "";
  sel.append(el("option", { value: "*", text: "♥ Όλα όσα μου αρέσουν (όλοι οι σταθμοί)" }));
  const keys = Object.keys(S.histCounts).filter((k) => S.histCounts[k] > 0 && getSt(k));
  if (S.cur && !keys.includes(S.cur.key) && getSt(S.cur.key)) keys.push(S.cur.key);
  keys.sort((a, b) => getSt(a).n.localeCompare(getSt(b).n, "el"));
  for (const k of keys) sel.append(el("option", { value: k, text: `${getSt(k).n} (${S.histCounts[k] || 0})` }));
  sel.value = keys.includes(key) || key === "*" ? key : "*";
  S.histKey = sel.value;
  await loadHistory();
}
$("histStation").addEventListener("change", () => { S.histKey = $("histStation").value; loadHistory(); });
$("histLikedOnly").addEventListener("change", renderHistory);
async function loadHistory() {
  try { S.histItems = (await api("history?k=" + encodeURIComponent(S.histKey))).items || []; } catch (e) { S.histItems = []; }
  if (S.histKey !== "*") S.histCounts[S.histKey] = S.histItems.length;
  renderHistory();
}
function renderHistory() {
  const all = S.histKey === "*";
  $("histTitle").textContent = all ? "Όσα μου αρέσουν" : (getSt(S.histKey) || { n: "Τραγούδια" }).n;
  $("btnExcel").hidden = all;
  document.querySelector(".col-st").hidden = !all;
  const likedOnly = $("histLikedOnly").checked || all;
  const items = S.histItems.filter((h) => !likedOnly || h.liked);
  const tb = $("histBody"); tb.textContent = "";
  for (const h of items) {
    const k = h.k || S.histKey;
    const like = el("button", { class: "icon-btn", "aria-label": h.liked ? "Δεν μου αρέσει πια" : "Μου αρέσει", onclick: async () => { h.liked = !h.liked; await api("like", { k, id: h.id, liked: h.liked }); renderHistory(); } }, el("img", { src: IMG(h.liked ? "DR-33" : "DR-32"), alt: "" }));
    const sp = listBtn(h, k, renderHistory);
    const del = el("button", { class: "icon-btn del", "aria-label": "Διαγραφή από το αρχείο", title: "Διαγραφή", onclick: () => confirmDelete(k, h), text: "×" });
    tb.append(el("tr", { class: h.liked ? "liked" : "" },
      el("td", { class: "num", text: fmtDate(h.ts) }), el("td", { class: "num", text: fmtTime(h.ts) }),
      el("td", { class: "art", text: h.artist || "—" }), el("td", { text: h.title }),
      all ? el("td", { class: "stc", text: h.station || "" }) : el("td", { class: "stc", hidden: true }),
      el("td", { class: "acts" }, like, sp, del)));
  }
  $("histEmpty").hidden = items.length > 0;
  document.querySelector(".table-wrap").hidden = items.length === 0;
}
function confirmDelete(k, h) {
  openModal("Διαγραφή τραγουδιού", [el("p", { text: `Να σβήσω το «${h.artist ? h.artist + " — " : ""}${h.title}» από το αρχείο;` })],
    [el("button", { class: "btn ghost", text: "Όχι", onclick: closeModal }),
     el("button", { class: "btn", text: "Ναι, σβήσ' το", onclick: async () => { closeModal(); await api("delete_item", { k, id: h.id }); loadHistory(); } })]);
}
$("btnExcel").addEventListener("click", () => doExport([S.histKey], $("histLikedOnly").checked));
$("btnExcelAll").addEventListener("click", () => doExport(["*"], $("histLikedOnly").checked || S.histKey === "*"));
async function doExport(keys, likedOnly) {
  try { const r = await api("export", { keys, liked_only: likedOnly }); toast(NATIVE ? "Διάλεξε πού θα αποθηκευτεί ή σε ποιον θα σταλεί το Excel." : "Το Excel αποθηκεύτηκε και ανοίγει: " + r.path.split(/[\\/]/).pop(), 5000); }
  catch (e) { toast(e.message); }
}

/* Spotify: λίστα ανά σταθμό, χωρίς λογαριασμό developer */
$("btnSpotifyList").addEventListener("click", () => {
  const all = S.histKey === "*";
  let items = S.histItems.filter((h) => h.liked);
  const name = all ? "DjFah Radio · Αγαπημένα" : "DjFah Radio · " + ((getSt(S.histKey) || {}).n || "");
  const build = (list) => {
    const seen = new Set(); const lines = [];
    for (const h of list.slice().reverse()) { const l = [h.artist, h.title].filter(Boolean).join(" - "); if (l && !seen.has(l.toLowerCase())) { seen.add(l.toLowerCase()); lines.push(l); } }
    return lines;
  };
  const showLines = (lines) => {
    const ta = el("textarea", { readonly: true, "aria-label": "Τραγούδια της λίστας" }); ta.value = lines.join("\n");
    openModal("Όλα μαζί στο Spotify (Tune My Music)", [
      el("p", {}, "Όνομα λίστας: ", el("span", { class: "pl-name", text: name })),
      el("ol", {},
        el("li", { text: "Πάτα «Αντιγραφή και άνοιγμα». Αντιγράφονται τα τραγούδια και ανοίγει η σελίδα Tune My Music." }),
        el("li", { text: "Κάνε επικόλληση (Ctrl+V) και πάτα να συνεχίσεις." }),
        el("li", { text: "Διάλεξε Spotify και συνδέσου (μόνο την πρώτη φορά)." }),
        el("li", { text: "Δώσε στη λίστα το παραπάνω όνομα. Δωρεάν έως 500 τραγούδια." })),
      ta, el("p", { class: "muted", text: plural(lines.length, "τραγούδι", "τραγούδια") })],
      [el("button", { class: "btn ghost", text: "Κλείσιμο", onclick: closeModal }),
       el("button", { class: "btn", text: "Αντιγραφή και άνοιγμα", onclick: async () => {
         try { await navigator.clipboard.writeText(ta.value); } catch (e) { ta.select(); document.execCommand("copy"); }
         await api("open_url", { url: "https://www.tunemymusic.com/transfer/freetext-to-spotify" });
         toast("Αντιγράφηκαν· κάνε επικόλληση στη σελίδα που άνοιξε.", 5000);
       } })]);
  };
  if (items.length) return showLines(build(items));
  const everything = S.histItems;
  if (!everything.length) return toast("Δεν υπάρχουν τραγούδια ακόμα.");
  openModal("Δεν έχεις σημειώσει τραγούδια", [el("p", { text: `Δεν έχεις πατήσει ♥ σε κανένα τραγούδι αυτού του σταθμού. Να φτιάξω τη λίστα με όλα τα τραγούδια που έπαιξαν (${everything.length});` })],
    [el("button", { class: "btn ghost", text: "Όχι", onclick: closeModal }), el("button", { class: "btn", text: "Ναι, με όλα", onclick: () => showLines(build(everything)) })]);
});

/* ---------------------------------------------------------------- βρες νέους */
let findReady = false;
function initFind() {
  if (findReady) return; findReady = true;
  const sel = $("findCc"); sel.append(el("option", { value: "", text: "Όλες οι χώρες" }));
  for (const c of S.catalog.countries) sel.append(el("option", { value: c.cc, text: c.name }));
}
const TAG_TO_G = { classical: "K", jazz: "J", indie: "A", alternative: "A", world: "W", folk: "F", electronic: "E", ambient: "E", rock: "R", soul: "S", blues: "S", experimental: "I", greek: "F", rebetiko: "F" };
$("findForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const cc = $("findCc").value, tag = $("findTag").value, name = $("findName").value.trim();
  if (!cc && !tag && !name) { toast("Διάλεξε χώρα, είδος ή γράψε όνομα."); return; }
  $("findInfo").textContent = "Ψάχνω…"; $("findList").textContent = "";
  try {
    const r = await api(`find?cc=${encodeURIComponent(cc)}&tag=${encodeURIComponent(tag)}&name=${encodeURIComponent(name)}&hq=${$("findHq").checked ? 1 : 0}`);
    $("findInfo").textContent = r.items.length ? `${r.items.length} μουσικοί σταθμοί, οι καλύτεροι σε ποιότητα πρώτοι.` : "Δεν βρέθηκαν σταθμοί με αυτά τα κριτήρια.";
    for (const s of r.items) $("findList").append(findRow(s, TAG_TO_G[tag] || ""));
  } catch (err) { $("findInfo").textContent = err.message; }
});
function findRow(s, g) {
  const k = "tmp:" + s.uuid;
  const st = { k, n: s.name.trim(), cc: s.cc, g, favicon: s.favicon };
  S.temp[k] = { ...st, streams: [s] };
  const q = s.quality === "hq";
  const tags = (s.tags || "").split(",").slice(0, 3).join(", ");
  const row = el("div", { class: "st" });
  row.append(logoEl(st),
    el("button", { class: "st-main", onclick: () => { S.tuneList = [k]; play(k); } },
      el("span", { class: "st-name", text: st.n }),
      el("span", { class: "st-sub" }, flag(s.cc), S.countryName[s.cc] || s.cc || "", tags ? el("span", { text: "· " + tags }) : null)),
    el("span", { class: "q-badge" }, q ? el("img", { src: IMG("DR-41"), alt: "Υψηλή ποιότητα" }) : null,
      el("span", { class: "chip" + (q ? "" : " std"), text: [String(s.codec || "").toUpperCase(), s.bitrate ? s.bitrate + "k" : ""].filter(Boolean).join(" ") || "ροή" })),
    el("button", { class: "icon-btn", "aria-label": "Δοκιμαστική ακρόαση", onclick: () => { S.tuneList = [k]; play(k); } }, el("img", { src: IMG("DR-30"), alt: "" })),
    el("button", { class: "btn ghost", text: "Προσθήκη", onclick: async (ev) => {
      try {
        const r = await api("mystation_add", { station: { uuid: s.uuid, name: st.n, cc: s.cc, favicon: s.favicon, g } });
        S.my = r.mystations; indexStations(); renderMy(); ev.target.textContent = "Προστέθηκε ✓"; ev.target.disabled = true;
        toast("Μπήκε στους «Οι σταθμοί μου».");
      } catch (e) { toast(e.message); }
    } }));
  return row;
}
$("urlForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await api("mystation_add", { station: { url: $("urlUrl").value.trim(), name: $("urlName").value.trim() } });
    S.my = r.mystations; indexStations(); renderMy(); $("urlForm").reset();
    toast("Ο σταθμός προστέθηκε στους «Οι σταθμοί μου».");
  } catch (err) { toast(err.message); }
});

/* ---------------------------------------------------------------- ρυθμίσεις */
function renderSettings() {
  $("setHq").checked = !!S.settings.hq_only;
  $("setCatUrl").value = S.settings.catalog_url || "";
  $("exportDir").textContent = NATIVE ? "Στο κινητό, το Excel ανοίγει στο μενού «Κοινοποίηση»: το αποθηκεύεις στα Αρχεία, στο Drive ή το στέλνεις με email." : "Αποθηκεύονται στον φάκελο: " + S.settings.export_dir;
  $("btnOpenFolder").hidden = NATIVE;
}
$("setHq").addEventListener("change", async () => {
  S.settings = (await api("settings", { hq_only: $("setHq").checked })).settings;
  renderHomeCounts(); if (S.list) renderList();
});
$("setCatUrl").addEventListener("change", async () => { S.settings = (await api("settings", { catalog_url: $("setCatUrl").value.trim() })).settings; });
$("btnCatUpdate").addEventListener("click", async () => {
  $("catMsg").textContent = "Ελέγχω…";
  try {
    const r = await api("catalog_update", {});
    $("catMsg").textContent = r.message;
    if (r.ok && r.catalog) { S.catalog = r.catalog; indexStations(); renderHome(); }
  } catch (e) { $("catMsg").textContent = e.message; }
});
$("btnRecheckAll").addEventListener("click", async () => {
  await api("resolve_all", {}); $("catMsg").textContent = "Ο έλεγχος ξεκίνησε· η πρόοδος φαίνεται κάτω αριστερά."; pollStatus();
});
$("btnOpenFolder").addEventListener("click", () => api("open_folder", {}).catch((e) => toast(e.message)));

/* ---------------------------------------------------------------- παράθυρα */
function openModal(title, bodyNodes, actions) {
  $("modalTitle").textContent = title;
  const b = $("modalBody"); b.textContent = ""; b.append(...bodyNodes);
  const a = $("modalActions"); a.textContent = ""; a.append(...(actions.length ? actions : [el("button", { class: "btn ghost", text: "Κλείσιμο", onclick: closeModal })]));
  $("modal").hidden = false;
  const f = a.querySelector("button:last-child") || b.querySelector("button"); if (f) f.focus();
}
function closeModal() { $("modal").hidden = true; }
$("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("modal").hidden) closeModal(); });

function showOffline(on) { $("offlineScreen").hidden = !on; }
window.addEventListener("offline", () => showOffline(true));
window.addEventListener("online", () => { showOffline(false); if (S.cur && !S.playing) play(S.cur.key); });
$("offlineRetry").addEventListener("click", async () => {
  if (navigator.onLine) { showOffline(false); await pollStatus(); if (S.cur) play(S.cur.key); }
  else toast("Ακόμα χωρίς σύνδεση.");
});

/* ---------------------------------------------------------------- Android: εγγενής αναπαραγωγή + Shazam */
if (NATIVE) {
  RP.addListener("state", ({ state }) => {
    if (nativeWait) { if (state === "playing") { const w = nativeWait; nativeWait = null; w.resolve(); } return; }
    if (state === "playing" && S.cur && !S.playing) { setPlayingUI(true); $("nowState").textContent = "Ζωντανά"; }
    else if (state === "paused" && S.playing) { setPlayingUI(false); $("nowState").textContent = "Σε παύση"; }
    else if ((state === "idle" || state === "ended") && S.playing) { toast("Η ροή διακόπηκε· ξανασυνδέομαι…"); reconnect(); }
  });
  RP.addListener("error", ({ message }) => {
    if (nativeWait) { const w = nativeWait; nativeWait = null; w.reject(new Error(message)); }
    else if (S.playing) { toast("Η ροή διακόπηκε· ξανασυνδέομαι…"); reconnect(); }
  });
  RP.addListener("meta", ({ title }) => { if (S.cur) { window.LocalAPI.recordTitle(S.cur.key, title, S.cur.st.n); pollNow(); } });
  RP.addListener("shared", ({ text }) => handleShared(text));
  RP.takeShared().then((r) => { if (r && r.text) setTimeout(() => handleShared(r.text), 2200); }).catch(() => {});
}
/* Κουμπί «πίσω» του Android: γυρίζει στην προηγούμενη οθόνη· στην αρχική η εφαρμογή πάει στο παρασκήνιο και η μουσική συνεχίζει */
window.djfahBack = function () {
  if (!$("modal").hidden) { closeModal(); return "ok"; }
  if (S.view === "home" && S.list) { closeList(); return "ok"; }
  if (viewStack.length) { show(viewStack.pop(), true); return "ok"; }
  if (S.view !== "home") { show("home", true); return "ok"; }
  return "exit";
};
/* Όταν η οθόνη της εφαρμογής ξανανοίγει ενώ η μουσική ήδη παίζει στο παρασκήνιο */
async function syncNative() {
  try {
    const st = await RP.getState();
    if (!st || !st.playing) return;
    const key = S.lastKey && getSt(S.lastKey) ? S.lastKey : null;
    if (!key) return;
    setCurrent(key, false);
    try { const info = await api("resolve?k=" + encodeURIComponent(key)); S.cur.streams = info.streams || []; } catch (e) { S.cur.streams = []; }
    const i = S.cur.streams.findIndex((s) => s.url === st.url);
    S.cur.idx = Math.max(0, i); S.cur.hls = !!(S.cur.streams[S.cur.idx] || {}).hls;
    setPlayingUI(true); setNowText("", "Ακούς ζωντανά", "Ζωντανά");
    show("player"); pollNow();
  } catch (e) { /* παλιά έκδοση */ }
}
/* Κείμενο από το Shazam («Κοινοποίηση → DjFah Radio»): συμπληρώνει τη φόρμα του σταθμού που ακούς */
function parseShared(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const pats = [/discover (.+?) by (.+?)(?:\.\s|\s+https?:|\.?$)/i,
    /(?:ανακαλύψω|βρω) (?:το |τον |την |τα )?[«"]?(.+)[»"]? (?:από|by) (.+?)(?:\.\s|\s+https?:|\.?$)/i,
    /Shazam[^:]*: (.+?) (?:-|by|από) (.+?)(?:\s+https?:|$)/i];
  for (const p of pats) { const m = t.match(p); if (m) return { title: m[1].trim(), artist: m[2].trim() }; }
  const clean = t.replace(/https?:\S+/g, "").trim();
  const i = clean.indexOf(" - ");
  return i > 0 ? { artist: clean.slice(0, i).trim(), title: clean.slice(i + 3).trim() } : { artist: "", title: clean };
}
function handleShared(text) {
  const p = parseShared(text);
  if (!p.title && !p.artist) return;
  show("player");
  $("manArtist").value = p.artist; $("manTitle").value = p.title;
  $("noTitles").hidden = false;
  toast(S.cur ? "Από το Shazam: έλεγξε τα στοιχεία και πάτα «Προσθήκη»." : "Διάλεξε πρώτα τον σταθμό που ακούς και μετά πάτα «Προσθήκη».", 6000);
}

boot();
