"""
DjFah Radio - τοπικός διακομιστής της εφαρμογής.

Τρέχει μόνο στον υπολογιστή (127.0.0.1). Κάνει τέσσερα πράγματα:
  1. Βρίσκει για κάθε σταθμό την καλύτερη ροή στη δωρεάν βάση Radio Browser.
  2. Περνάει τη ροή στο παράθυρο της εφαρμογής και διαβάζει τον τίτλο του τραγουδιού (ICY).
  3. Κρατάει ιστορικό, αγαπημένα και ρυθμίσεις σε αρχείο JSON.
  4. Φτιάχνει αρχεία Excel (.xlsx) χωρίς εξωτερικές βιβλιοθήκες.
Χρησιμοποιεί μόνο την τυπική βιβλιοθήκη της Python.
"""

import datetime as dt
import difflib
import http.server
import json
import os
import random
import re
import socket
import socketserver
import ssl
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
import webbrowser
import zipfile
from xml.sax.saxutils import escape as xesc

APP_NAME = "DjFah Radio"
APP_VERSION = "1.2.0"
PORT = int(os.environ.get("DJFAH_RADIO_PORT", "48231"))
APP_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(APP_DIR, "web")
DATA_DIR = os.environ.get("DJFAH_RADIO_DATA") or os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "DjFahRadio")
os.makedirs(DATA_DIR, exist_ok=True)
DATA_PATH = os.path.join(DATA_DIR, "data.json")
CATALOG_LOCAL = os.path.join(DATA_DIR, "stations.json")
CATALOG_BUNDLED = os.path.join(APP_DIR, "stations.json")
LOG_PATH = os.path.join(DATA_DIR, "radio.log")
UA = f"DjFahRadio/{APP_VERSION}"
RB_HOSTS = ["all.api.radio-browser.info", "de1.api.radio-browser.info", "de2.api.radio-browser.info",
            "fi1.api.radio-browser.info", "at1.api.radio-browser.info", "nl1.api.radio-browser.info"]
RB_BASE_OVERRIDE = os.environ.get("DJFAH_RB_BASE")       # για δοκιμές
RESOLVE_TTL = 3 * 24 * 3600
DEFAULT_CATALOG_URL = "https://raw.githubusercontent.com/fahtheo-Thodoris/djfah-radio/main/stations.json"
NON_MUSIC = {"news", "talk", "sports", "sport", "religion", "religious", "christian", "podcast", "politics",
             "information", "comedy", "ειδήσεις", "ενημέρωση", "church", "islam", "quran", "bible"}

if sys.stdout is None or sys.stderr is None:          # pythonw: χωρίς κονσόλα
    try:
        _log = open(LOG_PATH, "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or _log
        sys.stderr = sys.stderr or _log
    except Exception:
        pass


def log(*a):
    try:
        print(dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), *a, file=sys.stderr, flush=True)
    except Exception:
        pass


# ======================================================================== αποθήκευση
class Store:
    def __init__(self, path):
        self.path = path
        self.lock = threading.RLock()
        self.dirty = False
        self.d = {}
        try:
            with open(path, "r", encoding="utf-8") as f:
                self.d = json.load(f)
        except Exception:
            self.d = {}
        for k, v in (("settings", {}), ("favorites", []), ("mystations", []), ("history", {}),
                     ("resolved", {}), ("health", {}), ("last", None)):
            self.d.setdefault(k, v)
        s = self.d["settings"]
        s.setdefault("hq_only", True)
        s.setdefault("volume", 0.8)
        s.setdefault("catalog_url", "")
        s.setdefault("export_dir", os.path.join(os.path.expanduser("~"), "Documents", "DjFah Radio"))
        threading.Thread(target=self._saver, daemon=True).start()

    def touch(self):
        self.dirty = True

    def _saver(self):
        while True:
            time.sleep(2)
            if self.dirty:
                self.save()

    def save(self):
        with self.lock:
            self.dirty = False
            tmp = self.path + ".tmp"
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(self.d, f, ensure_ascii=False)
                os.replace(tmp, self.path)
            except Exception as e:
                log("save error", e)


STORE = None
CATALOG = {"stations": [], "countries": [], "genres": {}}
CAT_INDEX = {}


def load_catalog():
    global CATALOG, CAT_INDEX
    best = None
    for p in (CATALOG_LOCAL, CATALOG_BUNDLED):
        try:
            with open(p, "r", encoding="utf-8") as f:
                c = json.load(f)
            if best is None or str(c.get("version", "")) > str(best.get("version", "")):
                best = c
        except Exception:
            pass
    CATALOG = best or CATALOG
    CAT_INDEX = {s["k"]: s for s in CATALOG.get("stations", [])}


def update_catalog_from_remote():
    url = (STORE.d["settings"].get("catalog_url") or "").strip() or DEFAULT_CATALOG_URL
    if not url:
        return False, "Δεν έχει οριστεί διεύθυνση ενημέρωσης."
    try:
        c = json.loads(http_get(url, timeout=20).decode("utf-8"))
        assert isinstance(c.get("stations"), list) and c["stations"]
        if str(c.get("version", "")) <= str(CATALOG.get("version", "")):
            return True, "Η λίστα σταθμών είναι ήδη η πιο πρόσφατη."
        with open(CATALOG_LOCAL, "w", encoding="utf-8") as f:
            json.dump(c, f, ensure_ascii=False)
        load_catalog()
        return True, f"Η λίστα ενημερώθηκε (έκδοση {c.get('version')})."
    except Exception as e:
        return False, f"Η ενημέρωση δεν έγινε: {e}"


# ======================================================================== HTTP βοηθητικά
SSL_CTX = ssl.create_default_context()


def http_get(url, timeout=15, headers=None):
    h = {"User-Agent": UA}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
        return r.read()


_rb_good = None


def rb_get(path, params=None):
    """Κλήση στη δωρεάν βάση Radio Browser με εναλλαγή διακομιστών."""
    global _rb_good
    q = ("?" + urllib.parse.urlencode(params)) if params else ""
    bases = [RB_BASE_OVERRIDE] if RB_BASE_OVERRIDE else (
        ([_rb_good] if _rb_good else []) + [f"https://{h}" for h in RB_HOSTS if f"https://{h}" != _rb_good])
    last = None
    for b in bases:
        try:
            data = json.loads(http_get(b + path + q, timeout=12).decode("utf-8"))
            _rb_good = b
            return data
        except Exception as e:
            last = e
    raise RuntimeError(f"Η βάση σταθμών δεν απαντά ({last})")


# ======================================================================== ποιότητα
def quality_of(codec, bitrate, hls):
    c = (codec or "").upper()
    b = int(bitrate or 0)
    if "FLAC" in c:
        return "hq"
    if hls and b == 0:
        return "hq" if "AAC" in c or not c else "unknown"
    if b == 0:
        return "unknown"
    if "AAC" in c or "OPUS" in c or "OGG" in c or "VORBIS" in c:
        if b >= 128:
            return "hq"
        if b >= 96:
            return "std"
        return "low"
    if b >= 192:
        return "hq"
    if b >= 128:
        return "std"
    return "low"


Q_RANK = {"hq": 4, "unknown": 2.5, "std": 2, "low": 0}


def stream_score(s):
    sc = Q_RANK.get(s["quality"], 0) * 10
    sc += min(int(s.get("bitrate") or 0), 320) / 40.0
    if not s.get("hls"):
        sc += 3                       # μη-HLS: διαβάζουμε τίτλους τραγουδιών
    if s.get("ok"):
        sc += 6
    sc += min(int(s.get("votes") or 0), 5000) / 1000.0
    return sc


# ======================================================================== ονόματα
GREEK = {"α": "a", "β": "v", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "i", "θ": "th", "ι": "i", "κ": "k",
         "λ": "l", "μ": "m", "ν": "n", "ξ": "x", "ο": "o", "π": "p", "ρ": "r", "σ": "s", "ς": "s", "τ": "t",
         "υ": "y", "φ": "f", "χ": "ch", "ψ": "ps", "ω": "o"}


def norm(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).casefold()
    s = "".join(GREEK.get(c, c) for c in s)
    s = re.sub(r"[^\w]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def name_sim(q, name):
    a, b = norm(q), norm(name)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    r = difflib.SequenceMatcher(None, a, b).ratio()
    ta, tb = set(a.split()), set(b.split())
    if ta and ta <= tb:
        r = max(r, 0.82 - 0.03 * max(0, len(tb) - len(ta)))
    if b.startswith(a + " ") or b.endswith(" " + a):
        r = max(r, 0.8)
    return r


def to_stream(r):
    url = r.get("url_resolved") or r.get("url") or ""
    hls = bool(r.get("hls")) or ".m3u8" in url.lower()
    return {"uuid": r.get("stationuuid"), "name": r.get("name", ""), "url": url, "codec": r.get("codec", ""),
            "bitrate": int(r.get("bitrate") or 0), "hls": hls, "ok": bool(r.get("lastcheckok")),
            "votes": int(r.get("votes") or 0), "favicon": r.get("favicon") or "", "homepage": r.get("homepage") or "",
            "tags": r.get("tags") or "", "cc": r.get("countrycode") or "",
            "quality": quality_of(r.get("codec"), r.get("bitrate"), hls)}


def resolve_station(st, force=False):
    """Βρίσκει τις ροές ενός σταθμού του καταλόγου ή των «Οι σταθμοί μου»."""
    key = st["k"]
    cached = STORE.d["resolved"].get(key)
    if cached and not force and time.time() - cached.get("t", 0) < RESOLVE_TTL:
        return cached
    streams = []
    if st.get("uuids"):
        try:
            res = rb_get("/json/stations/byuuid", {"uuids": ",".join(st["uuids"])})
            streams = [to_stream(r) for r in res]
        except Exception as e:
            if cached:
                return cached
            raise
    if st.get("url") and not streams:
        u = st["url"]
        streams = [{"uuid": None, "name": st["n"], "url": u, "codec": "", "bitrate": 0, "hls": ".m3u8" in u.lower(),
                    "ok": True, "votes": 0, "favicon": st.get("favicon", ""), "homepage": "", "tags": "",
                    "cc": st.get("cc", ""), "quality": "unknown"}]
    if not streams:
        found, best_sim = {}, 0.0
        for q in st.get("q") or [st["n"]]:
            base = {"name": q, "hidebroken": "false", "order": "votes", "reverse": "true", "limit": "40"}
            if st.get("cc"):
                base["countrycode"] = st["cc"]          # μόνο στη χώρα του σταθμού
            for params in (base,):
                try:
                    res = rb_get("/json/stations/search", params)
                except Exception:
                    if cached:
                        return cached
                    raise
                for r in res:
                    sim = name_sim(q, r.get("name", ""))
                    if sim < 0.62:
                        continue
                    u = r.get("stationuuid")
                    if u not in found or found[u][0] < sim:
                        found[u] = (sim, r)
                    best_sim = max(best_sim, sim)
                if found:
                    break
            if found and best_sim >= 0.95:
                break
        streams = [to_stream(r) for sim, r in found.values() if sim >= best_sim - 0.06]
    seen, uniq = set(), []
    for s in sorted(streams, key=stream_score, reverse=True):
        if s["url"] and s["url"] not in seen:
            seen.add(s["url"])
            uniq.append(s)
    uniq = uniq[:6]
    qual = uniq[0]["quality"] if uniq else "none"
    fav = next((s["favicon"] for s in uniq if s["favicon"]), "")
    any_ok = any(s["ok"] for s in uniq)
    info = {"t": time.time(), "streams": uniq, "quality": qual, "favicon": fav, "any_ok": any_ok}
    with STORE.lock:
        STORE.d["resolved"][key] = info
        STORE.touch()
    return info


RESOLVE_STATE = {"running": False, "done": 0, "total": 0}


def resolve_all_background():
    if RESOLVE_STATE["running"]:
        return
    RESOLVE_STATE["running"] = True

    def work():
        try:
            items = list(CATALOG.get("stations", [])) + list(STORE.d["mystations"])
            todo = [s for s in items if time.time() - (STORE.d["resolved"].get(s["k"]) or {}).get("t", 0) > RESOLVE_TTL]
            RESOLVE_STATE["total"] = len(todo)
            RESOLVE_STATE["done"] = 0
            for s in todo:
                try:
                    info = resolve_station(s)
                    if info["streams"] and not info["any_ok"]:
                        mark_health(s["k"], False)
                except Exception as e:
                    log("resolve", s.get("k"), e)
                    if "βάση σταθμών" in str(e):
                        time.sleep(20)
                RESOLVE_STATE["done"] += 1
                time.sleep(0.15)
        finally:
            RESOLVE_STATE["running"] = False

    threading.Thread(target=work, daemon=True).start()


# ======================================================================== υγεία σταθμών
def today():
    return dt.date.today().isoformat()


def mark_health(key, ok):
    with STORE.lock:
        h = STORE.d["health"].setdefault(key, {"fails": [], "last_ok": None})
        if ok:
            h["last_ok"] = today()
            h["fails"] = []
        else:
            if today() not in h["fails"]:
                h["fails"] = (h["fails"] + [today()])[-10:]
        STORE.touch()


def is_offline(key):
    h = STORE.d["health"].get(key)
    if not h:
        return False
    fails = sorted(h.get("fails") or [])
    if len(fails) < 3:
        return False
    recent = fails[-3:]
    d0 = dt.date.fromisoformat(recent[0])
    if (dt.date.today() - d0).days > 6:
        return False
    return not h.get("last_ok") or h["last_ok"] < recent[0]


# ======================================================================== ιστορικό
NOW = {}            # key -> {"artist","title","raw","ts","meta"}
NOW_LOCK = threading.Lock()
JUNK = re.compile(r"^(\s*|-+|\.+|unknown|unknown - unknown|advert|advertisement|commercial|jingle|"
                  r"station id|ad break|sponsor|n/a|null|none|live|on air)$", re.I)


def split_title(raw, station_name=""):
    t = re.sub(r"\s+", " ", (raw or "").replace("\x00", "")).strip().strip("'\"")
    if not t or JUNK.match(t) or "http://" in t or "https://" in t or len(t) > 220:
        return None
    if station_name and norm(t) == norm(station_name):
        return None
    for sep in (" - ", " – ", " — ", " -- ", " | ", " / "):
        if sep in t:
            a, b = t.split(sep, 1)
            if a.strip() and b.strip():
                return a.strip(), b.strip(), t
    return "", t, t


def record_title(key, raw, station_name, source="stream"):
    parts = split_title(raw, station_name)
    with NOW_LOCK:
        cur = NOW.get(key) or {}
        if parts is None:
            NOW[key] = {"artist": "", "title": "", "raw": raw or "", "ts": time.time(), "meta": True}
            return
        artist, title, rawc = parts
        if cur.get("raw") == rawc:
            return
        NOW[key] = {"artist": artist, "title": title, "raw": rawc, "ts": time.time(), "meta": True}
    with STORE.lock:
        hist = STORE.d["history"].setdefault(key, [])
        if hist and hist[-1].get("raw") == rawc and time.time() - hist[-1]["ts"] < 1800:
            return
        hist.append({"id": f"{int(time.time()*1000)}{random.randint(100, 999)}", "ts": time.time(),
                     "artist": artist, "title": title, "raw": rawc, "liked": False, "src": source})
        if len(hist) > 5000:
            del hist[: len(hist) - 5000]
        STORE.touch()


# ======================================================================== ροή + ICY
class StreamError(Exception):
    pass


def open_upstream(url, depth=0):
    """Ανοίγει ροή (http/https), δέχεται και «ICY 200 OK». Επιστρέφει (sock, headers, προ-διαβασμένα bytes)."""
    if depth > 6:
        raise StreamError("πολλές ανακατευθύνσεις")
    u = urllib.parse.urlsplit(url)
    if u.scheme not in ("http", "https"):
        raise StreamError("μη υποστηριζόμενη διεύθυνση")
    host, port = u.hostname, u.port or (443 if u.scheme == "https" else 80)
    path = (u.path or "/") + (("?" + u.query) if u.query else "")
    raw = socket.create_connection((host, port), timeout=12)
    sock = SSL_CTX.wrap_socket(raw, server_hostname=host) if u.scheme == "https" else raw
    sock.settimeout(25)
    hosthdr = host if (u.port is None) else f"{host}:{u.port}"
    req = (f"GET {path} HTTP/1.0\r\nHost: {hosthdr}\r\nUser-Agent: {UA}\r\nAccept: */*\r\n"
           f"Icy-MetaData: 1\r\nConnection: close\r\n\r\n")
    sock.sendall(req.encode("latin-1", "replace"))
    buf = b""
    while b"\r\n\r\n" not in buf and b"\n\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
        if len(buf) > 65536:
            break
    sep = b"\r\n\r\n" if b"\r\n\r\n" in buf else b"\n\n"
    head, _, rest = buf.partition(sep)
    lines = head.decode("latin-1", "replace").splitlines()
    if not lines:
        sock.close()
        raise StreamError("κενή απάντηση")
    status = lines[0].split()
    code = int(status[1]) if len(status) > 1 and status[1].isdigit() else 0
    hdrs = {}
    for ln in lines[1:]:
        if ":" in ln:
            k, v = ln.split(":", 1)
            hdrs[k.strip().lower()] = v.strip()
    if code in (301, 302, 303, 307, 308) and hdrs.get("location"):
        sock.close()
        return open_upstream(urllib.parse.urljoin(url, hdrs["location"]), depth + 1)
    if code != 200:
        sock.close()
        raise StreamError(f"ο σταθμός απάντησε {code}")
    ctype = hdrs.get("content-type", "").lower()
    low = u.path.lower()
    if ("mpegurl" in ctype or "scpls" in ctype or low.endswith((".m3u", ".pls")) or ctype.startswith("text/")) \
            and "vnd.apple" not in ctype and not low.endswith(".m3u8"):
        body = rest
        while len(body) < 65536:
            c = sock.recv(8192)
            if not c:
                break
            body += c
        sock.close()
        txt = body.decode("utf-8", "replace")
        m = re.search(r"(?im)^(?:file\d+=)?\s*(https?://\S+)", txt)
        if not m:
            raise StreamError("κενή λίστα αναπαραγωγής")
        return open_upstream(m.group(1).strip(), depth + 1)
    if "vnd.apple" in ctype or low.endswith(".m3u8"):
        sock.close()
        raise StreamError("hls")
    return sock, hdrs, rest


def recv_exact(sock, n, pre):
    """Διαβάζει ακριβώς n bytes, χρησιμοποιώντας πρώτα όσα υπάρχουν στο pre."""
    out = bytearray(pre[:n])
    pre = pre[n:]
    while len(out) < n:
        c = sock.recv(min(65536, n - len(out)))
        if not c:
            raise StreamError("η ροή διακόπηκε")
        out += c
    return bytes(out), pre


def decode_meta(b, cc):
    b = b.rstrip(b"\x00")
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        enc = "cp1253" if cc in ("GR", "CY") else "cp1251" if cc in ("RU", "UA", "BG", "RS") else "cp1252"
        return b.decode(enc, "replace")


def content_type_for(ctype, url):
    c = (ctype or "").lower()
    if "aacp" in c or "aac" in c:
        return "audio/aac"
    if "ogg" in c or "opus" in c:
        return "audio/ogg"
    if "flac" in c:
        return "audio/flac"
    if "mpeg" in c or "mp3" in c:
        return "audio/mpeg"
    if url.lower().endswith(".aac"):
        return "audio/aac"
    return c or "audio/mpeg"


# ======================================================================== Excel (xlsx)
def _col(i):
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def _cell(ref, v, style=0):
    st = f' s="{style}"' if style else ""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return f'<c r="{ref}"{st}><v>{v}</v></c>'
    t = xesc(str(v if v is not None else "")).replace("\x00", "")
    t = re.sub(r"[\x01-\x08\x0b\x0c\x0e-\x1f]", "", t)
    return f'<c r="{ref}" t="inlineStr"{st}><is><t xml:space="preserve">{t}</t></is></c>'


def write_xlsx(path, sheets):
    """sheets: [(όνομα, [επικεφαλίδες], [γραμμές], [πλάτη])]"""
    used, names = set(), []
    for name, *_ in sheets:
        n = re.sub(r"[\[\]:*?/\\]", " ", name)[:31].strip() or "Φύλλο"
        base, k = n, 2
        while n.lower() in used:
            n = f"{base[:28]} {k}"
            k += 1
        used.add(n.lower())
        names.append(n)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        ct = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
              '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
              '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
              '<Default Extension="xml" ContentType="application/xml"/>',
              '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
              '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>']
        for i in range(len(sheets)):
            ct.append(f'<Override PartName="/xl/worksheets/sheet{i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
        ct.append("</Types>")
        z.writestr("[Content_Types].xml", "".join(ct))
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
                   '</Relationships>')
        wb = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
              'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>']
        rels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']
        for i, n in enumerate(names):
            wb.append(f'<sheet name="{xesc(n)}" sheetId="{i+1}" r:id="rId{i+1}"/>')
            rels.append(f'<Relationship Id="rId{i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i+1}.xml"/>')
        rels.append(f'<Relationship Id="rId{len(names)+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>')
        wb.append("</sheets></workbook>")
        rels.append("</Relationships>")
        z.writestr("xl/workbook.xml", "".join(wb))
        z.writestr("xl/_rels/workbook.xml.rels", "".join(rels))
        z.writestr("xl/styles.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                   '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
                   '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>'
                   '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
                   '<fill><patternFill patternType="solid"><fgColor rgb="FF6B3A1E"/></patternFill></fill></fills>'
                   '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs>'
                   '<cellXfs count="2"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/></cellXfs>'
                   '</styleSheet>')
        for i, (_, headers, rows, widths) in enumerate(sheets):
            x = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                 '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
                 '<cols>']
            for j, w in enumerate(widths):
                x.append(f'<col min="{j+1}" max="{j+1}" width="{w}" customWidth="1"/>')
            x.append("</cols><sheetData>")
            x.append('<row r="1">' + "".join(_cell(f"{_col(j)}1", h, 1) for j, h in enumerate(headers)) + "</row>")
            for r, row in enumerate(rows, start=2):
                x.append(f'<row r="{r}">' + "".join(_cell(f"{_col(j)}{r}", v) for j, v in enumerate(row)) + "</row>")
            x.append("</sheetData>")
            last = f"{_col(len(headers)-1)}{max(1, len(rows)+1)}"
            x.append(f'<autoFilter ref="A1:{last}"/></worksheet>')
            z.writestr(f"xl/worksheets/sheet{i+1}.xml", "".join(x))


def station_name(key):
    st = CAT_INDEX.get(key) or next((s for s in STORE.d["mystations"] if s["k"] == key), None)
    return st["n"] if st else key


def export_history(keys, liked_only=False):
    folder = STORE.d["settings"]["export_dir"]
    os.makedirs(folder, exist_ok=True)
    sheets = []
    heads = ["Ημερομηνία", "Ώρα", "Καλλιτέχνης", "Τίτλος", "Μου αρέσει", "Σταθμός"]
    for k in keys:
        rows = []
        for h in STORE.d["history"].get(k, []):
            if liked_only and not h.get("liked"):
                continue
            t = dt.datetime.fromtimestamp(h["ts"])
            rows.append([t.strftime("%d/%m/%Y"), t.strftime("%H:%M"), h.get("artist", ""), h.get("title", ""),
                         "♥" if h.get("liked") else "", station_name(k)])
        if rows:
            sheets.append((station_name(k), heads, rows, [12, 7, 32, 40, 11, 26]))
    if not sheets:
        return None
    stamp = dt.datetime.now().strftime("%Y-%m-%d_%H%M")
    label = station_name(keys[0]) if len(keys) == 1 else "Όλοι οι σταθμοί"
    label = re.sub(r'[<>:"/\\|?*]+', " ", label).strip()
    path = os.path.join(folder, f"DjFah Radio - {label} - {stamp}.xlsx")
    write_xlsx(path, sheets)
    return path


def open_path(p):
    try:
        if sys.platform == "win32":
            os.startfile(p)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", p])
        else:
            subprocess.Popen(["xdg-open", p])
        return True
    except Exception as e:
        log("open", p, e)
        return False


def open_url(url, prefer_app_uri=None):
    if prefer_app_uri and sys.platform == "win32":
        try:
            os.startfile(prefer_app_uri)
            return True
        except Exception:
            pass
    try:
        webbrowser.open(url)
        return True
    except Exception:
        return False


# ======================================================================== αναζήτηση νέων σταθμών
def find_stations(cc="", tag="", name="", hq_only=True):
    params = {"hidebroken": "true", "order": "votes", "reverse": "true", "limit": "120"}
    if cc:
        params["countrycode"] = cc
    if tag:
        params["tag"] = tag
    if name:
        params["name"] = name
    res = rb_get("/json/stations/search", params)
    out = []
    for r in res:
        tags = {t.strip().lower() for t in (r.get("tags") or "").split(",") if t.strip()}
        if tags & NON_MUSIC:
            continue
        s = to_stream(r)
        if hq_only and s["quality"] not in ("hq", "unknown"):
            continue
        out.append(s)
    out.sort(key=stream_score, reverse=True)
    return out[:60]


# ======================================================================== διακομιστής
LAST_BEAT = [time.time()]
ACTIVE_STREAMS = [0]


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "DjFahRadio"
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *args):
        pass

    # ---------------------------------------------------------------- βοηθητικά
    def send_json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def qs(self):
        return {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).items()}

    def local_only(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            self.send_error(403)
            return False
        return True

    # ---------------------------------------------------------------- GET
    def do_GET(self):
        if not self.local_only():
            return
        path = urllib.parse.urlsplit(self.path).path
        try:
            if path == "/" or path == "/index.html":
                return self.static("index.html")
            if path.startswith("/web/"):
                return self.static(path[5:])
            if path == "/stream":
                return self.stream()
            if path.startswith("/api/"):
                return self.api_get(path[5:])
            self.send_error(404)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as e:
            log("GET error", path, repr(e))
            try:
                self.send_json({"error": str(e)}, 500)
            except Exception:
                pass

    def static(self, rel):
        p = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not p.startswith(WEB_DIR) or not os.path.isfile(p):
            return self.send_error(404)
        ext = os.path.splitext(p)[1].lower()
        ct = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
              ".css": "text/css; charset=utf-8", ".webp": "image/webp", ".png": "image/png",
              ".woff2": "font/woff2", ".json": "application/json", ".svg": "image/svg+xml",
              ".ico": "image/x-icon"}.get(ext, "application/octet-stream")
        with open(p, "rb") as f:
            b = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-cache" if ext in (".html", ".js", ".css") else "max-age=86400")
        self.end_headers()
        self.wfile.write(b)

    def api_get(self, name):
        q = self.qs()
        if name == "boot":
            s = STORE.d
            return self.send_json({
                "version": APP_VERSION, "settings": s["settings"], "favorites": s["favorites"],
                "mystations": s["mystations"], "last": s.get("last"), "catalog": CATALOG,
                "resolved": {k: {"quality": v.get("quality"), "favicon": v.get("favicon"), "any_ok": v.get("any_ok"),
                                 "n": len(v.get("streams") or [])} for k, v in s["resolved"].items()},
                "offline": [k for k in s["health"] if is_offline(k)],
                "hist_counts": {k: len(v) for k, v in s["history"].items() if v},
                "resolve": RESOLVE_STATE})
        if name == "status":
            return self.send_json({
                "resolve": RESOLVE_STATE,
                "resolved": {k: {"quality": v.get("quality"), "favicon": v.get("favicon"), "any_ok": v.get("any_ok"),
                                 "n": len(v.get("streams") or [])} for k, v in STORE.d["resolved"].items()},
                "offline": [k for k in STORE.d["health"] if is_offline(k)]})
        if name == "resolve":
            key = q.get("k", "")
            st = CAT_INDEX.get(key) or next((s for s in STORE.d["mystations"] if s["k"] == key), None)
            if not st:
                return self.send_json({"error": "Δεν βρέθηκε ο σταθμός."}, 404)
            try:
                info = resolve_station(st, force=q.get("force") == "1")
            except Exception as e:
                return self.send_json({"error": str(e), "offline_net": True}, 502)
            return self.send_json(info)
        if name == "now":
            with NOW_LOCK:
                return self.send_json(NOW.get(q.get("k", "")) or {})
        if name == "history":
            key = q.get("k", "")
            if key == "*":
                items = []
                for k, lst in STORE.d["history"].items():
                    for h in lst:
                        if h.get("liked"):
                            items.append(dict(h, k=k, station=station_name(k)))
                items.sort(key=lambda h: h["ts"], reverse=True)
                return self.send_json({"items": items[:2000]})
            lst = STORE.d["history"].get(key, [])
            return self.send_json({"items": list(reversed(lst[-2000:]))})
        if name == "find":
            try:
                res = find_stations(q.get("cc", ""), q.get("tag", ""), q.get("name", ""), q.get("hq", "1") == "1")
            except Exception as e:
                return self.send_json({"error": str(e)}, 502)
            return self.send_json({"items": res})
        if name == "ping":
            return self.send_json({"ok": True, "app": APP_NAME, "version": APP_VERSION})
        self.send_error(404)

    # ---------------------------------------------------------------- POST
    def do_POST(self):
        if not self.local_only():
            return
        path = urllib.parse.urlsplit(self.path).path
        try:
            b = self.body()
            name = path[5:] if path.startswith("/api/") else ""
            d = STORE.d
            if name == "beat":
                LAST_BEAT[0] = time.time()
                return self.send_json({"ok": True})
            if name == "fav":
                with STORE.lock:
                    f = d["favorites"]
                    if b.get("k") in f:
                        f.remove(b["k"])
                    else:
                        f.append(b["k"])
                    STORE.touch()
                return self.send_json({"favorites": d["favorites"]})
            if name == "like":
                with STORE.lock:
                    for h in d["history"].get(b.get("k"), []):
                        if h["id"] == b.get("id"):
                            h["liked"] = bool(b.get("liked"))
                    STORE.touch()
                return self.send_json({"ok": True})
            if name == "sent":
                with STORE.lock:
                    lists = d.setdefault("spotify_lists", [])
                    first = b.get("k") not in lists
                    if first:
                        lists.append(b.get("k"))
                    for h in d["history"].get(b.get("k"), []):
                        if h["id"] == b.get("id"):
                            h["sent"] = True
                    STORE.touch()
                return self.send_json({"first": first})
            if name == "like_now":
                key = b.get("k")
                with STORE.lock:
                    lst = d["history"].get(key) or []
                    if not lst:
                        return self.send_json({"error": "Δεν υπάρχει τραγούδι για σημείωση."}, 400)
                    lst[-1]["liked"] = not lst[-1].get("liked")
                    STORE.touch()
                    return self.send_json({"item": lst[-1]})
            if name == "manual":
                raw = f"{(b.get('artist') or '').strip()} - {(b.get('title') or '').strip()}".strip(" -")
                if not raw:
                    return self.send_json({"error": "Γράψε καλλιτέχνη ή τίτλο."}, 400)
                with NOW_LOCK:
                    NOW.pop(b.get("k"), None)
                record_title(b.get("k"), raw, "", source="manual")
                with STORE.lock:
                    lst = d["history"].get(b.get("k")) or []
                    if lst and b.get("liked"):
                        lst[-1]["liked"] = True
                    STORE.touch()
                return self.send_json({"ok": True})
            if name == "delete_item":
                with STORE.lock:
                    lst = d["history"].get(b.get("k")) or []
                    d["history"][b.get("k")] = [h for h in lst if h["id"] != b.get("id")]
                    STORE.touch()
                return self.send_json({"ok": True})
            if name == "health":
                mark_health(b.get("k"), bool(b.get("ok")))
                return self.send_json({"offline": is_offline(b.get("k"))})
            if name == "last":
                with STORE.lock:
                    d["last"] = b.get("k")
                    STORE.touch()
                return self.send_json({"ok": True})
            if name == "settings":
                with STORE.lock:
                    for k in ("hq_only", "volume", "catalog_url"):
                        if k in b:
                            d["settings"][k] = b[k]
                    STORE.touch()
                return self.send_json({"settings": d["settings"]})
            if name == "mystation_add":
                s = b.get("station") or {}
                if not (s.get("uuid") or s.get("url")):
                    return self.send_json({"error": "Λείπει η διεύθυνση του σταθμού."}, 400)
                key = "my:" + (s.get("uuid") or re.sub(r"[^a-z0-9]+", "-", s["url"].lower())[-40:])
                st = {"k": key, "n": (s.get("name") or "Σταθμός").strip()[:80], "cc": (s.get("cc") or "").upper(),
                      "g": s.get("g") or "", "hq": False, "my": True,
                      "uuids": [s["uuid"]] if s.get("uuid") else [], "url": s.get("url") if not s.get("uuid") else "",
                      "favicon": s.get("favicon") or ""}
                with STORE.lock:
                    d["mystations"] = [m for m in d["mystations"] if m["k"] != key] + [st]
                    d["resolved"].pop(key, None)
                    STORE.touch()
                try:
                    resolve_station(st, force=True)
                except Exception as e:
                    log("mystation resolve", e)
                return self.send_json({"mystations": d["mystations"], "k": key})
            if name == "mystation_remove":
                with STORE.lock:
                    d["mystations"] = [m for m in d["mystations"] if m["k"] != b.get("k")]
                    if b.get("k") in d["favorites"]:
                        d["favorites"].remove(b.get("k"))
                    STORE.touch()
                return self.send_json({"mystations": d["mystations"]})
            if name == "export":
                keys = b.get("keys") or []
                if keys == ["*"]:
                    keys = [k for k, v in d["history"].items() if v]
                p = export_history(keys, bool(b.get("liked_only")))
                if not p:
                    return self.send_json({"error": "Δεν υπάρχουν τραγούδια για εξαγωγή."}, 400)
                if b.get("open", True):
                    open_path(p)
                return self.send_json({"path": p})
            if name == "open_folder":
                f = d["settings"]["export_dir"]
                os.makedirs(f, exist_ok=True)
                return self.send_json({"ok": open_path(f)})
            if name == "open_url":
                url = b.get("url") or ""
                if not re.match(r"^https://", url):
                    return self.send_json({"error": "μη έγκυρη διεύθυνση"}, 400)
                app_uri = b.get("app_uri") if (b.get("app_uri") or "").startswith("spotify:") else None
                return self.send_json({"ok": open_url(url, app_uri)})
            if name == "catalog_update":
                ok, msg = update_catalog_from_remote()
                if ok:
                    resolve_all_background()
                return self.send_json({"ok": ok, "message": msg, "catalog": CATALOG})
            if name == "resolve_all":
                with STORE.lock:
                    for v in d["resolved"].values():
                        v["t"] = 0
                    d["health"] = {}
                    STORE.touch()
                resolve_all_background()
                return self.send_json({"ok": True})
            if name == "recheck":
                key = b.get("k")
                st = CAT_INDEX.get(key) or next((s for s in d["mystations"] if s["k"] == key), None)
                if st:
                    with STORE.lock:
                        d["health"].pop(key, None)
                    try:
                        info = resolve_station(st, force=True)
                        return self.send_json(info)
                    except Exception as e:
                        return self.send_json({"error": str(e)}, 502)
                return self.send_json({"error": "Δεν βρέθηκε"}, 404)
            if name == "quit":
                self.send_json({"ok": True})
                threading.Thread(target=lambda: (time.sleep(0.3), STORE.save(), os._exit(0)), daemon=True).start()
                return
            self.send_error(404)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as e:
            log("POST error", path, repr(e))
            try:
                self.send_json({"error": str(e)}, 500)
            except Exception:
                pass

    # ---------------------------------------------------------------- ροή
    def stream(self):
        q = self.qs()
        url, key = q.get("u", ""), q.get("k", "")
        st = CAT_INDEX.get(key) or next((s for s in STORE.d["mystations"] if s["k"] == key), None) or {}
        cc = st.get("cc", "")
        sname = st.get("n", "")
        try:
            sock, hdrs, pre = open_upstream(url)
        except StreamError as e:
            return self.send_json({"error": str(e)}, 502)
        except Exception as e:
            return self.send_json({"error": f"σύνδεση: {e}"}, 502)
        ACTIVE_STREAMS[0] += 1
        try:
            metaint = int(hdrs.get("icy-metaint") or 0)
            with NOW_LOCK:
                cur = NOW.get(key)
                if not cur or not cur.get("meta"):
                    NOW[key] = {"artist": "", "title": "", "raw": "", "ts": time.time(), "meta": bool(metaint)}
            if hdrs.get("icy-name") and not metaint:
                pass
            self.send_response(200)
            self.send_header("Content-Type", content_type_for(hdrs.get("content-type"), url))
            self.send_header("Cache-Control", "no-cache, no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            out = self.wfile
            if not metaint:
                if pre:
                    out.write(pre)
                while True:
                    c = sock.recv(32768)
                    if not c:
                        break
                    out.write(c)
            else:
                while True:
                    audio, pre = recv_exact(sock, metaint, pre)
                    out.write(audio)
                    lb, pre = recv_exact(sock, 1, pre)
                    ln = lb[0] * 16
                    if ln:
                        meta, pre = recv_exact(sock, ln, pre)
                        txt = decode_meta(meta, cc)
                        m = re.search(r"StreamTitle='(.*?)';", txt, re.S) or re.search(r"StreamTitle='(.*)", txt, re.S)
                        if m:
                            record_title(key, m.group(1).rstrip("';"), sname)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, StreamError, socket.timeout, OSError):
            pass
        finally:
            ACTIVE_STREAMS[0] -= 1
            try:
                sock.close()
            except Exception:
                pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = sys.platform != "win32"


# ======================================================================== εκκίνηση
def find_edge():
    cands = []
    for env in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"):
        base = os.environ.get(env)
        if base:
            cands.append(os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"))
    for env in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
        base = os.environ.get(env)
        if base:
            cands.append(os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"))
    return next((c for c in cands if os.path.isfile(c)), None)


def open_window():
    url = f"http://127.0.0.1:{PORT}/"
    exe = find_edge()
    if exe:
        prof = os.path.join(DATA_DIR, "window")
        try:
            subprocess.Popen([exe, f"--app={url}", f"--user-data-dir={prof}", "--window-size=1360,880",
                              "--autoplay-policy=no-user-gesture-required", "--no-first-run",
                              "--disable-features=Translate"], close_fds=True)
            return
        except Exception as e:
            log("edge", e)
    webbrowser.open(url)


def already_running():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/ping", timeout=2) as r:
            return json.loads(r.read().decode()).get("app") == APP_NAME
    except Exception:
        return False


def watchdog():
    """Κλείνει τον διακομιστή όταν κλείσει το παράθυρο (χωρίς σήμα για 45 δευτερόλεπτα)."""
    while True:
        time.sleep(10)
        if time.time() - LAST_BEAT[0] > 45 and ACTIVE_STREAMS[0] == 0:
            log("window closed, exiting")
            STORE.save()
            os._exit(0)


def main(open_ui=True):
    global STORE
    if already_running():
        if open_ui:
            open_window()
        return
    STORE = Store(DATA_PATH)
    load_catalog()
    srv = Server(("127.0.0.1", PORT), Handler)
    log(f"{APP_NAME} {APP_VERSION} on port {PORT}")
    threading.Thread(target=resolve_all_background, daemon=True).start()
    threading.Thread(target=update_catalog_from_remote, daemon=True).start()
    if open_ui:
        LAST_BEAT[0] = time.time() + 30          # χρόνος για να ανοίξει το παράθυρο
        threading.Thread(target=watchdog, daemon=True).start()
        threading.Timer(0.4, open_window).start()
    try:
        srv.serve_forever()
    finally:
        STORE.save()


# ======================================================================== αυτοέλεγχος εγκατάστασης
def selftest(log_path):
    lines, failed = [], []

    def step(name, fn, critical=True):
        try:
            r = fn()
            lines.append(f"OK    {name}" + (f"  ({r})" if r else ""))
        except Exception as e:
            m = str(e)
            lines.append(f"FAIL  {name}: {m[:160]}")
            if critical:
                failed.append(name)

    def t_files():
        for f in ("index.html", "app.js", "app.css", "hls.min.js", "img/DR-06-radio.webp", "img/DR-07-base.webp"):
            assert os.path.isfile(os.path.join(WEB_DIR, f)), f
        load_catalog()
        return f"{len(CATALOG['stations'])} σταθμοί, {len(CATALOG['countries'])} χώρες"

    def t_xlsx():
        p = os.path.join(DATA_DIR, "selftest.xlsx")
        write_xlsx(p, [("Δοκιμή", ["Α", "Β"], [["Καλλιτέχνης", "Τίτλος"]], [20, 20])])
        with zipfile.ZipFile(p) as z:
            assert "xl/worksheets/sheet1.xml" in z.namelist()
        os.remove(p)
        return "Excel"

    def t_titles():
        assert split_title("Miles Davis - So What", "") == ("Miles Davis", "So What", "Miles Davis - So What")
        assert split_title("", "") is None
        return "ανάγνωση τίτλων"

    def t_rb():
        res = rb_get("/json/stations/search", {"name": "FIP", "countrycode": "FR", "limit": "5"})
        assert res, "κενή απάντηση"
        return f"βάση σταθμών: {res[0].get('name')}"

    step("Αρχεία εφαρμογής", t_files)
    step("Δημιουργία Excel", t_xlsx)
    step("Τίτλοι τραγουδιών", t_titles)
    step("Σύνδεση με τη βάση σταθμών", t_rb, critical=False)
    with open(log_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 1 if failed else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        STORE = Store(os.path.join(DATA_DIR, "selftest-data.json"))
        sys.exit(selftest(sys.argv[sys.argv.index("--selftest") + 1]))
    main(open_ui="--no-window" not in sys.argv)
