#!/usr/bin/env python3
"""End-to-end checks in headless Chrome. External services are mocked; lyrics are placeholder text.
Run from the repo root after `python3 build.py`:  python3 test/run.py"""
import base64, hashlib, json, os, struct, subprocess, sys, time, zlib, urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "out"
OUT.mkdir(parents=True, exist_ok=True)
BASE = "http://127.0.0.1:8888/"
LIVE_URL = "https://yappyap0427-png.github.io/lyrics-studio/"

FIX_LRC = """[00:01.00]Placeholder line number one
[00:04.00]第二行測試歌詞
[00:07.50]Third test line goes here
[00:11.00]第四行用來測試很長的句子會不會自動折成兩行並且保持平衡
[00:16.00]
[00:24.00]Fifth line after a break
[00:28.00]最後一行"""

def png(w, h, fn):
    raw = b"".join(b"\x00" + b"".join(bytes(fn(x, y)) for x in range(w)) for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")

ART = png(160, 160, lambda x, y: (int(30 + x * 1.3), int(40 + y * 0.4), int(140 - y * 0.5)) if (x - 100) ** 2 + (y - 60) ** 2 > 900 else (255, 200, 60))
# 480x360 "YouTube" thumbnail with black letterbox bars (45px top/bottom)
THUMB = png(480, 360, lambda x, y: (0, 0, 0) if y < 45 or y >= 315 else (200, int(60 + x / 4), 120))

T0 = time.time()
state = {"cp_calls": 0, "token_calls": 0, "lrclib": [], "cp_start": time.time(), "lrclib_hang": False}

def record(i, track, artist, dur, synced=True):
    return {"id": i, "name": track, "trackName": track, "artistName": artist, "albumName": "Test Album", "duration": dur,
            "instrumental": False, "plainLyrics": "plain text", "syncedLyrics": FIX_LRC if synced else None}

def handler(route, request):
    url = request.url
    u = urllib.parse.urlparse(url)
    q = dict(urllib.parse.parse_qsl(u.query))
    host = u.hostname or ""
    if u.scheme == "file" or host in ("127.0.0.1", "localhost"):
        return route.continue_()
    if host == "lrclib.net":
        hdr = {"Access-Control-Allow-Origin": "*", "Content-Type": "application/json"}
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers={**hdr, "Access-Control-Allow-Headers": "Lrclib-Client"})
        state["lrclib"].append(u.path + "?" + u.query)
        if state["lrclib_hang"]:
            state.setdefault("hung", []).append(route)
            return  # never answer: the page's own timeout has to give up
        if u.path == "/api/get":
            # exact lookup fails → forces the search fallback path
            return route.fulfill(status=404, headers=hdr, body=json.dumps({"message": "Failed to find specified track", "name": "TrackNotFound", "statusCode": 404}))
        if u.path == "/api/search":
            lst = [record(11, "Test Song", "Someone Else", 99), record(12, "Test Song", "Test Artist", 180 if "q" not in q else 200), record(13, "Test Song (Live)", "Test Artist", 260, synced=False)]
            return route.fulfill(status=200, headers=hdr, body=json.dumps(lst))
        if u.path.startswith("/api/get/"):
            return route.fulfill(status=200, headers=hdr, body=json.dumps(record(12, "Test Song", "Test Artist", 180)))
        return route.fulfill(status=404, headers=hdr, body="{}")
    if host == "api.spotify.com":
        hdr = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization", "Content-Type": "application/json"}
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=hdr)
        state["cp_calls"] += 1
        auth = request.headers.get("authorization", "")
        if auth == "Bearer EXPIRED":
            return route.fulfill(status=401, headers=hdr, body=json.dumps({"error": {"status": 401, "message": "The access token expired"}}))
        if auth == "Bearer NOPLAY":
            return route.fulfill(status=204, headers=hdr, body="")
        if auth == "Bearer DENIED":
            return route.fulfill(status=403, headers=hdr, body=json.dumps({"error": {"status": 403, "message": "Check settings on developer.spotify.com/dashboard, the user may not be registered."}}))
        prog = int((time.time() - state["cp_start"]) * 1000) + 3000
        body = {"timestamp": 0, "progress_ms": prog, "is_playing": True, "currently_playing_type": "track",
                "item": {"id": "t1", "name": "Test Song", "duration_ms": 180000, "artists": [{"name": "Test Artist"}],
                         "album": {"name": "Test Album", "images": [{"url": "https://i.scdn.co/image/test640", "width": 640, "height": 640}, {"url": "https://i.scdn.co/image/test64", "width": 64, "height": 64}]}}}
        return route.fulfill(status=200, headers=hdr, body=json.dumps(body))
    if host == "accounts.spotify.com" and u.path == "/api/token":
        state["token_calls"] += 1
        hdr = {"Access-Control-Allow-Origin": "*", "Content-Type": "application/json"}
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers={**hdr, "Access-Control-Allow-Headers": "Content-Type"})
        form = dict(urllib.parse.parse_qsl(request.post_data or ""))
        state.setdefault("token_forms", []).append(form)
        return route.fulfill(status=200, headers=hdr, body=json.dumps({"access_token": "FRESH", "token_type": "Bearer", "expires_in": 3600, "refresh_token": "R2", "scope": "user-read-currently-playing"}))
    if host == "i.scdn.co":
        return route.fulfill(status=200, headers={"Access-Control-Allow-Origin": "*", "Content-Type": "image/png"}, body=ART)
    if host == "i.ytimg.com":
        if "maxresdefault" in u.path:
            return route.fulfill(status=404, headers={"Access-Control-Allow-Origin": "*"}, body=b"")
        return route.fulfill(status=200, headers={"Access-Control-Allow-Origin": "*", "Content-Type": "image/png"}, body=THUMB)
    return route.abort()  # fonts, youtube.com etc. are unreachable in the sandbox

FAKE_YT = """
window.YT = { Player: class {
  constructor(el, o) { this.o = o; this.vid = o.videoId; this.base = 0; this.t0 = performance.now(); this.st = -1; this.vol = 100; this.muted = true;
    window.__yt = this;
    const f = document.createElement('iframe'); f.id = 'ytplayer'; document.getElementById(el).replaceWith(f);
    setTimeout(() => o.events.onReady && o.events.onReady({ target: this }), 60); }
  playVideo() { if (this.st !== 1) { this.st = 1; this.t0 = performance.now(); } }
  pauseVideo() { this.base = this.getCurrentTime(); this.st = 2; }
  getPlayerState() { return this.st; }
  getCurrentTime() { return this.st === 1 ? this.base + (performance.now() - this.t0) / 1000 : this.base; }
  getDuration() { return 200; }
  getVideoData() { return { video_id: this.vid, title: window.__ytTitle || 'Test Artist - Test Song (Official Music Video)', author: window.__ytAuthor || 'TestArtistVEVO' }; }
  loadVideoById(id) { this.vid = id; this.base = 0; this.t0 = performance.now(); this.st = 1; }
  seekTo(s) { this.base = s; this.t0 = performance.now(); }
  setVolume(v) { this.vol = v; } getVolume() { return this.vol; } unMute() { this.muted = false; } isMuted() { return this.muted; }
} };
"""

results = []
def check(name, cond, info=""):
    results.append((name, bool(cond), info))
    print(("PASS " if cond else "FAIL ") + name + (("  — " + str(info)) if info and not cond else ""))

def snap(page, name):
    data = page.evaluate("document.getElementById('stage').toDataURL('image/png')")
    (OUT / name).write_bytes(base64.b64decode(data.split(",", 1)[1]))

def settle(page, js_before="", wait=0.9):
    if js_before:
        page.evaluate(js_before)
    page.wait_for_timeout(int(wait * 1000))

def wait_js(page, js, timeout=5000):
    try:
        page.wait_for_function(js, timeout=timeout)
        return True
    except Exception:
        return False

def wake(page):
    vp = page.viewport_size or {"width": 1600, "height": 900}
    x, y = vp["width"] * 0.45, vp["height"] * 0.47
    page.mouse.move(x, y); page.mouse.move(x + 10, y + 10)

def toast(page):
    return page.inner_text("#toast .msg")

# every message the app shows, in order (the visible toast can be replaced before a check reads it)
TOAST_HOOK = """(() => { if (window.__toastHooked) return; const o = window.toast; window.__toasts = [];
  window.toast = function (m) { window.__toasts.push(String(m)); return o.apply(this, arguments); }; window.__toastHooked = true; })()"""
def hook_toasts(page):
    page.evaluate(TOAST_HOOK)
def toasts(page):
    return page.evaluate("window.__toasts || []")
def said(page, n, text):
    return any(text in t for t in toasts(page)[n:])

def ffprobe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,nb_read_frames:format=duration,format_name", "-count_frames", "-of", "json", str(path)], capture_output=True, text=True)
    return json.loads(r.stdout or "{}")

def media_duration(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    ts = []
    for x in r.stdout.split():
        try: ts.append(float(x.strip(",")))
        except ValueError: pass
    return round(max(ts) - min(ts), 2) if ts else 0.0

def frame_hash(path, at):
    r = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(at), "-i", str(path), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-s", "192x108", "-"], capture_output=True)
    return hashlib.md5(r.stdout).hexdigest() if r.stdout else None

def save_download(page, action_js, name, timeout=15000):
    with page.expect_download(timeout=timeout) as dl:
        page.evaluate(action_js)
    f = OUT / (name + Path(dl.value.suggested_filename).suffix)
    dl.value.save_as(str(f))
    return f, dl.value.suggested_filename

srv = subprocess.Popen([sys.executable, "-m", "http.server", "8888", "--bind", "127.0.0.1"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
errors = []
try:
    with sync_playwright() as p:
        exe = os.environ.get("CHROME_PATH") or ("/usr/bin/google-chrome" if Path("/usr/bin/google-chrome").exists() else None)
        browser = p.chromium.launch(executable_path=exe, headless=True, args=[
            "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
            "--auto-accept-this-tab-capture", "--enable-unsafe-swiftshader"])

        def watch(pg):
            pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
            pg.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
            return pg

        def new_page(vw=1600, vh=900, init=None):
            ctx = browser.new_context(viewport={"width": vw, "height": vh}, device_scale_factor=1, accept_downloads=True)
            ctx.route("**/*", handler)
            if init:
                ctx.add_init_script(init)
            return ctx, watch(ctx.new_page())

        # ---------- A. demo mode, default theme ----------
        ctx, page = new_page()
        page.goto(BASE)
        page.wait_for_timeout(1200)
        page.evaluate("LyricsStudio.r.warm = -1e9")  # keep blur on in the slow software renderer
        check("demo: status text", page.inner_text("#status") == "示範模式", page.inner_text("#status"))
        st = page.evaluate("({s: LyricsStudio.r.lyr.status, n: LyricsStudio.r.lyr.entries.length, w: stage.width, h: stage.height})")
        check("demo: synced lyrics loaded", st["s"] == "synced" and st["n"] >= 10, st)
        check("demo: fit canvas matches viewport", st["w"] == 1600 and st["h"] == 900, st)
        check("demo: no address warning on 127.0.0.1", page.evaluate("document.getElementById('envBar').hidden"))
        settle(page, "LyricsStudio.sources.demo.jump(5.2)", 1.0); snap(page, "A1-flow-fit-line.png")
        settle(page, "LyricsStudio.sources.demo.jump(13.2)", 1.0); snap(page, "A2-flow-fit-bilingual.png")
        settle(page, "LyricsStudio.sources.demo.jump(31.5)", 1.2); snap(page, "A3-flow-fit-interlude.png")
        dots = page.evaluate("(() => { const E = LyricsStudio.r.lyr.entries; const i = LRC.activeIndex(E, 31.5); return E[i].type + ':' + E[i].show; })()")
        check("demo: interlude entry active at 31.5s", dots == "gap:true", dots)
        settle(page, "LyricsStudio.sources.demo.jump(5.2)", 0.6)
        wake(page); page.wait_for_timeout(300)
        page.screenshot(path=str(OUT / "A4-ui-dock.png"))
        sc = page.evaluate("({scrub: !document.getElementById('scrub').hidden, vol: !document.getElementById('volWrap').hidden, sr: document.getElementById('srLyric').textContent})")
        check("demo: seek bar shown, volume hidden (demo has no sound)", sc["scrub"] and not sc["vol"], sc)
        check("screen reader line follows the lyrics", len(sc["sr"]) > 0, sc)

        # layouts
        settle(page, "LyricsStudio.S.layout='16:9'; LyricsStudio.resize(); LyricsStudio.sources.demo.jump(20.6)", 1.0); snap(page, "B1-flow-16x9.png")
        check("layout 16:9 is 1920x1080", page.evaluate("stage.width+'x'+stage.height") == "1920x1080")
        settle(page, "LyricsStudio.S.layout='9:16'; LyricsStudio.resize(); LyricsStudio.sources.demo.jump(40.6)", 1.0); snap(page, "B2-flow-9x16.png")
        check("layout 9:16 is 1080x1920", page.evaluate("stage.width+'x'+stage.height") == "1080x1920")
        # themes
        settle(page, "LyricsStudio.S.layout='16:9'; LyricsStudio.resize(); LyricsStudio.S.theme='serif'; LyricsStudio.r.setTheme('serif'); LyricsStudio.sources.demo.jump(8.6)", 1.0); snap(page, "C1-serif-16x9.png")
        settle(page, "LyricsStudio.S.layout='9:16'; LyricsStudio.resize(); LyricsStudio.sources.demo.jump(16.8)", 1.0); snap(page, "C2-serif-9x16.png")
        settle(page, "LyricsStudio.S.layout='16:9'; LyricsStudio.resize(); LyricsStudio.S.theme='cinema'; LyricsStudio.r.setTheme('cinema'); LyricsStudio.sources.demo.jump(3.2)", 1.4); snap(page, "C3-cinema-16x9.png")
        settle(page, "LyricsStudio.S.layout='9:16'; LyricsStudio.resize(); LyricsStudio.sources.demo.jump(12.4)", 1.0); snap(page, "C4-cinema-9x16.png")

        # ---------- E. recording (canvas only) ----------
        page.evaluate("LyricsStudio.S.theme='flow'; LyricsStudio.r.setTheme('flow'); LyricsStudio.S.layout='16:9'; LyricsStudio.resize(); LyricsStudio.sources.demo.jump(2.5)")
        mime = page.evaluate("Recorder.mime(false) + ' | ' + Recorder.mime(true) + ' | webm: ' + Recorder.mime(false, 'webm')")
        print("   recorder mime:", mime)
        page.evaluate("LyricsStudio.rec.start({audio:'none', fps:30, bitrate:8e6})")
        page.wait_for_timeout(500)
        check("record: recbar visible", page.is_visible("#recbar"))
        check("record: layout button locked", page.evaluate("document.getElementById('btnLayout').disabled"))
        page.wait_for_timeout(3000)
        f1, name1 = save_download(page, "LyricsStudio.rec.stop()", "E1-record-silent")
        info = ffprobe(f1)
        vs = [s for s in info.get("streams", []) if s.get("codec_type") == "video"]
        check("record: file has a 1920x1080 video stream", vs and vs[0].get("width") == 1920 and vs[0].get("height") == 1080, info)
        print("   silent file:", name1, f1.stat().st_size, "bytes", info.get("format", {}).get("format_name"), vs and vs[0].get("codec_name"))
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "1.5", "-i", str(f1), "-frames:v", "1", str(OUT / "E2-record-frame.png")])
        check("record: frame extracted", (OUT / "E2-record-frame.png").exists())
        check("record: state back to idle, layout unlocked", page.evaluate("LyricsStudio.rec.state === 'idle' && !document.getElementById('btnLayout').disabled"))

        # ---------- E3. pause / resume: paused time is left out ----------
        page.evaluate("LyricsStudio.rec.start({audio:'none', fps:30, bitrate:8e6})")
        page.wait_for_timeout(1500)
        page.click("#recPause")
        page.wait_for_timeout(200)
        p1 = page.evaluate("({st: LyricsStudio.rec.state, cls: document.body.classList.contains('rec-paused'), btn: document.getElementById('recPause').textContent, e: LyricsStudio.rec.elapsed()})")
        wake(page); page.screenshot(path=str(OUT / "E3-recbar-paused.png"))
        page.wait_for_timeout(1500)
        e2 = page.evaluate("LyricsStudio.rec.elapsed()")
        check("pause: state, button and timer freeze", p1["st"] == "paused" and p1["cls"] and p1["btn"] == "繼續" and abs(e2 - p1["e"]) < 0.01, (p1, e2))
        page.keyboard.press("p")  # P resumes
        page.wait_for_timeout(1500)
        check("pause: P key resumes", page.evaluate("LyricsStudio.rec.state") == "recording")
        f3, _ = save_download(page, "LyricsStudio.rec.stop()", "E3-record-paused")
        d3 = media_duration(f3)
        print("   paused recording duration:", d3, "(wall time ~4.7 s, 1.5 s of it paused)")
        check("pause: paused part is not in the file", 2.4 < d3 < 4.0, d3)

        # ---------- E4. hidden tab: a worker keeps frames coming ----------
        page.evaluate("""(() => { const A = LyricsStudio; A.__steps = 0;
            if (!A.__origStep) { A.__origStep = A.step; A.step = function () { A.__steps++; return A.__origStep.call(A); }; }
            A.simHidden = true; })()""")
        page.wait_for_timeout(1000)
        idle_steps = page.evaluate("LyricsStudio.__steps")
        check("hidden: no drawing while hidden and not recording", idle_steps == 0, idle_steps)
        page.evaluate("LyricsStudio.simHidden = false; LyricsStudio.sources.demo.jump(3); LyricsStudio.rec.start({audio:'none', fps:30, bitrate:8e6})")
        page.wait_for_timeout(600)
        s0 = page.evaluate("LyricsStudio.__steps"); page.wait_for_timeout(1500); vis = page.evaluate("LyricsStudio.__steps") - s0
        page.evaluate("LyricsStudio.simHidden = true")
        page.wait_for_timeout(200)
        s1 = page.evaluate("LyricsStudio.__steps"); page.wait_for_timeout(1500); hid = page.evaluate("LyricsStudio.__steps") - s1
        print(f"   frames in 1.5 s while recording: visible {vis}, hidden (worker) {hid}")
        check("hidden: worker ticker keeps drawing at about the visible rate", hid >= max(4, 0.5 * vis), (vis, hid))
        page.wait_for_timeout(1500)  # past the 4.2 s health check: a healthy recording must survive it
        check("hidden: health check leaves a good recording alone", page.evaluate("LyricsStudio.rec.state") == "recording")
        f4, _ = save_download(page, "LyricsStudio.rec.stop()", "E4-record-hidden")
        h_a, h_b = frame_hash(f4, 0.6), frame_hash(f4, 4.2)
        d4 = media_duration(f4)
        check("hidden: video keeps moving (frames differ)", h_a and h_b and h_a != h_b, (h_a, h_b))
        check("hidden: duration matches", 4.0 < d4 < 6.5, d4)
        page.evaluate("LyricsStudio.simHidden = false")
        page.wait_for_timeout(300)
        check("hidden: ticker stopped after recording", page.evaluate("LyricsStudio.ticker === null"))

        # ---------- E5. encoder that writes nothing: caught, explained, no empty download ----------
        downloads = []
        page.on("download", lambda d: downloads.append(d.suggested_filename))
        # WebM delivers data every second, so an empty recording is caught while it runs
        page.evaluate("LyricsStudio.S.recFormat = 'webm'; LyricsStudio.rec.onData = () => {}; LyricsStudio.rec.start({audio:'none', fps:30, bitrate:8e6, format:'webm'})")
        page.wait_for_timeout(5000)
        e5 = page.evaluate("({st: LyricsStudio.rec.state})")
        check("health (WebM): empty recording stopped within seconds, nothing saved", e5["st"] == "idle" and not downloads, (e5, downloads))
        check("health (WebM): advice to lower fps / quality", "30 fps" in toast(page), toast(page))
        # MP4 is handed over only at the end: an empty one is caught after stopping, then WebM is used
        page.evaluate("LyricsStudio.S.recFormat = 'auto'; LyricsStudio.rec.start({audio:'none', fps:30, bitrate:8e6, format:'auto'})")
        page.wait_for_timeout(500)
        check("record (MP4): no running size shown, estimate kept for the memory limit", page.evaluate("LyricsStudio.rec.streaming === false && document.getElementById('recBytes').hidden && LyricsStudio.rec.size() > 0"))
        page.wait_for_timeout(3300)
        check("health (MP4): no false alarm while recording", page.evaluate("LyricsStudio.rec.state") == "recording")
        page.evaluate("LyricsStudio.rec.stop()")
        page.wait_for_timeout(800)
        e5b = page.evaluate("({st: LyricsStudio.rec.state, fmt: LyricsStudio.S.recFormat, saved: JSON.parse(localStorage.getItem('ls.settings')).recFormat})")
        check("health (MP4): empty file not saved, switched to WebM", e5b["st"] == "idle" and not downloads and e5b["fmt"] == "webm" and e5b["saved"] == "webm" and "WebM" in toast(page), (e5b, downloads, toast(page)))
        check("health: sticky message with a close button", page.evaluate("document.getElementById('toast').classList.contains('sticky')"))
        page.screenshot(path=str(OUT / "E5-sticky-toast.png"))
        page.click("#toast .x")
        page.wait_for_timeout(200)
        check("health: message closes", not page.evaluate("document.getElementById('toast').classList.contains('show')"))
        page.evaluate("delete LyricsStudio.rec.onData")

        # ---------- E7. memory limit: warn, then stop and save ----------
        hook_toasts(page); n0 = len(toasts(page))
        # 8 Mbps ≈ 1 MB/s: the warning comes at ~3 s (85 %), the stop at ~4 s
        with page.expect_download(timeout=9000) as dl7:
            page.evaluate("LyricsStudio.rec.maxBytes = 3.5e6; LyricsStudio.rec.start({audio:'none', fps:30, bitrate:8e6, format:'auto'})")
        page.wait_for_timeout(300)
        t7 = toasts(page)[n0:]
        check("limit: warns before the limit, then stops and saves", said(page, n0, "記憶體") and said(page, n0, "容量上限") and dl7.value.suggested_filename.endswith(".mp4"), t7)
        page.evaluate("LyricsStudio.rec.maxBytes = 1.5 * 1024 ** 3")

        # ---------- E6. record dialog → countdown → cancel / start ----------
        page.keyboard.press("r")
        page.wait_for_timeout(300)
        check("record dialog: remembers the WebM switch", page.input_value("#recFmt") == "webm", page.input_value("#recFmt"))
        page.select_option("#recFmt", "auto"); page.check("#recCd"); page.check("#recForm input[value=none]")
        page.click("#recForm button[type=submit]")
        page.wait_for_timeout(400)
        cd = page.evaluate("({vis: !document.getElementById('countdown').hidden, n: document.getElementById('cdNum').textContent, st: LyricsStudio.rec.state})")
        page.screenshot(path=str(OUT / "E6-countdown.png"))
        check("countdown: shows 3 while ready", cd["vis"] and cd["n"] == "3" and cd["st"] == "ready", cd)
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        cd2 = page.evaluate("({vis: !document.getElementById('countdown').hidden, st: LyricsStudio.rec.state})")
        check("countdown: Esc cancels", not cd2["vis"] and cd2["st"] == "idle" and "取消" in toast(page), (cd2, toast(page)))
        page.keyboard.press("r")
        page.wait_for_timeout(300)
        page.click("#recForm button[type=submit]")
        page.wait_for_timeout(1500)
        check("countdown: not recording yet during the count", page.evaluate("LyricsStudio.rec.state") == "ready")
        ok = wait_js(page, "LyricsStudio.rec.state === 'recording'", 3000)
        check("countdown: recording starts after 3 s", ok)
        page.wait_for_timeout(1200)
        with page.expect_download(timeout=15000) as dl6:
            page.click("#recStop")
        check("record: stop button saves the file", dl6.value.suggested_filename.endswith((".mp4", ".webm")), dl6.value.suggested_filename)

        # ---------- F. recording with microphone (fake device) ----------
        page.evaluate("LyricsStudio.rec.start({audio:'mic', fps:30, bitrate:8e6})")
        page.wait_for_timeout(2500)
        f2, _ = save_download(page, "LyricsStudio.rec.stop()", "F1-record-mic")
        info2 = ffprobe(f2)
        kinds = sorted(s.get("codec_type") for s in info2.get("streams", []))
        check("record+mic: has audio and video", kinds == ["audio", "video"], info2)
        print("   mic file codecs:", [(s.get("codec_type"), s.get("codec_name")) for s in info2.get("streams", [])])
        check("record+mic: microphone released after saving", page.evaluate("LyricsStudio.rec.cleanup.length === 0"))

        # ---------- F2. tab audio via getDisplayMedia (may be unsupported headless) ----------
        try:
            page.evaluate("LyricsStudio.rec.start({audio:'system', fps:30, bitrate:8e6, preferTab:true}).catch(e => LyricsStudio.recError(e))")
            page.wait_for_timeout(2000)
            if page.evaluate("LyricsStudio.rec.active"):
                f5, n5 = save_download(page, "LyricsStudio.rec.stop()", "F2-record-tab")
                print("   tab-audio recording worked:", n5)
            else:
                print("   tab-audio capture not available in headless (expected); toast:", toast(page))
        except Exception as ex:
            print("   tab-audio capture skipped:", str(ex)[:120])
        ctx.close()

        # ---------- M. menus, typing in search, settings that survive a reload ----------
        ctx, page = new_page()
        page.goto(BASE)
        page.wait_for_timeout(1000)
        order = page.evaluate("THEME_ORDER")
        page.click("#btnTheme")
        page.wait_for_timeout(250)
        m = page.evaluate("""(() => { const m = document.querySelector('.menu[role=menu]'); if (!m) return null;
            return { n: m.querySelectorAll('[role=menuitemradio]').length, focus: document.activeElement.dataset.id,
                     exp: document.getElementById('btnTheme').getAttribute('aria-expanded') }; })()""")
        check("menu: theme menu lists every style, focus on the current one", m and m["n"] == len(order) and m["focus"] == "flow" and m["exp"] == "true", m)
        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(150)
        pv = page.evaluate("({f: document.activeElement.dataset.id, r: LyricsStudio.r.theme, s: LyricsStudio.S.theme})")
        check("menu: arrow key previews the next style without saving", pv["f"] == order[1] and pv["r"] == order[1] and pv["s"] == "flow", pv)
        page.wait_for_timeout(600)
        page.screenshot(path=str(OUT / "M1-theme-menu.png"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        esc = page.evaluate("({menu: !!document.querySelector('.menu'), r: LyricsStudio.r.theme, f: document.activeElement.id})")
        check("menu: Esc closes, drops the preview, focus back on the button", not esc["menu"] and esc["r"] == "flow" and esc["f"] == "btnTheme", esc)
        page.click("#btnTheme"); page.wait_for_timeout(200)
        page.click(f".menu [data-id={order[2]}]")
        page.wait_for_timeout(200)
        pick = page.evaluate("({s: LyricsStudio.S.theme, menu: !!document.querySelector('.menu'), label: document.getElementById('btnTheme').textContent})")
        label2 = page.evaluate(f"THEMES['{order[2]}'].label")
        check("menu: clicking a style applies it", pick["s"] == order[2] and not pick["menu"] and pick["label"] == label2, pick)
        page.click("#btnLayout"); page.wait_for_timeout(200)
        page.screenshot(path=str(OUT / "M2-layout-menu.png"))
        page.click(".menu [data-id='1:1']")
        page.wait_for_timeout(300)
        check("menu: layout 1:1 is 1440x1440", page.evaluate("stage.width+'x'+stage.height") == "1440x1440")
        # shortcuts never fire while typing in the search box
        page.keyboard.press("l")
        page.wait_for_timeout(500)
        page.fill("#q", "")
        page.type("#q", "street flower", delay=15)
        tp = page.evaluate("({q: document.getElementById('q').value, theme: LyricsStudio.S.theme, full: !!document.fullscreenElement, rec: document.getElementById('dlgRec').open, ui: document.body.classList.contains('hideui')})")
        check("search box: typing 'street flower' triggers no shortcut", tp["q"] == "street flower" and tp["theme"] == order[2] and not tp["full"] and not tp["rec"] and not tp["ui"], tp)
        page.keyboard.press("Enter")
        page.wait_for_timeout(800)
        check("search box: Enter searches", page.evaluate("document.querySelectorAll('#results .res').length") == 3)
        page.click("#searchClose")
        # settings
        page.click("#btnSettings"); page.wait_for_timeout(250)
        page.uncheck("#setKaraoke"); page.select_option("#setAlign", "left")
        page.click("#dlgSettings [data-close]")
        page.wait_for_timeout(200)
        page.keyboard.press("]"); page.keyboard.press("]")
        page.wait_for_timeout(200)
        page.reload()
        page.wait_for_timeout(1200)
        sv = page.evaluate("({t: LyricsStudio.S.theme, l: LyricsStudio.S.layout, k: LyricsStudio.S.karaoke, a: LyricsStudio.S.align, o: LyricsStudio.S.offset, off: document.getElementById('offVal').textContent, bl: document.getElementById('btnLayout').textContent, w: stage.width})")
        check("settings: style, size, karaoke, alignment and offset survive a reload",
              sv["t"] == order[2] and sv["l"] == "1:1" and sv["k"] is False and sv["a"] == "left" and abs(sv["o"] - 0.2) < 1e-6 and sv["off"] == "+0.2s" and sv["bl"] == "1:1" and sv["w"] == 1440, sv)
        page.click("#btnSettings"); page.wait_for_timeout(200)
        check("settings: dialog shows the saved values", not page.is_checked("#setKaraoke") and page.input_value("#setAlign") == "left")
        page.click("#dlgSettings [data-close]")
        ctx.close()

        # ---------- K. click a line to jump, seek bar, double-click to pause (demo) ----------
        ctx, page = new_page()
        page.goto(BASE)
        page.wait_for_timeout(1000)
        page.evaluate("LyricsStudio.sources.demo.jump(4); LyricsStudio.sources.demo.togglePlay()")  # pause so lines hold still
        page.wait_for_timeout(1300)
        tgt = page.evaluate("""(() => { const A = LyricsStudio, r = A.r, E = r.lyr.entries, g = r.g, c = stage;
            const cur = LRC.activeIndex(E, A.clock.now() - A.S.offset); let j = -1;
            for (let i = cur + 2; i < E.length; i++) if (E[i].type === 'line' && E[i].L && E[i].L.y != null) { j = i; break; }
            if (j < 0) return null;
            const L = E[j].L, b = c.getBoundingClientRect(), px = g.lx + Math.min(g.lw * 0.3, 80), py = L.y + L.h / 2;
            return { j, t: E[j].time, text: E[j].text, hit: r.hitLine(px, py), x: b.left + px * b.width / c.width, y: b.top + py * b.height / c.height }; })()""")
        check("seek: a later line is on screen and hit-testable", tgt and tgt["hit"] == tgt["j"], tgt)
        if tgt:
            page.mouse.move(tgt["x"], tgt["y"])
            page.wait_for_timeout(100)
            check("seek: pointer shows the line is clickable", page.evaluate("stage.classList.contains('seekable')"))
            page.mouse.click(tgt["x"], tgt["y"])
            page.wait_for_timeout(300)
            pos = page.evaluate("LyricsStudio.sources.demo.pos")
            check("seek: clicking a line jumps to it", abs(pos - (tgt["t"] + 0.02)) < 0.15, (pos, tgt))
        wake(page)
        page.fill("#seek", "500")
        page.wait_for_timeout(300)
        pos2 = page.evaluate("LyricsStudio.sources.demo.pos")
        check("seek bar: dragging to the middle jumps to 0:30", abs(pos2 - 30) < 0.3, pos2)
        empty = page.evaluate("""(() => { const r = LyricsStudio.r, c = stage, b = c.getBoundingClientRect();
            for (const fx of [0.97, 0.03, 0.9]) { const px = c.width * fx, py = c.height * 0.5;
              const x = b.left + px * b.width / c.width, y = b.top + py * b.height / c.height;
              if (r.hitLine(px, py) < 0 && document.elementFromPoint(x, y) === c) return { x, y }; }
            return null; })()""")
        before = page.evaluate("LyricsStudio.sources.demo.playing")
        if empty:
            page.mouse.dblclick(empty["x"], empty["y"])
            page.wait_for_timeout(200)
        check("double-click away from the lyrics toggles play", empty and page.evaluate("LyricsStudio.sources.demo.playing") != before, (empty, before))
        page.screenshot(path=str(OUT / "K1-seekbar.png"))

        # ---------- L. lyrics service that never answers: give up after the timeout ----------
        page.evaluate("Lyrics.timeoutMs = 1200")
        state["lrclib_hang"] = True
        t0 = time.time()
        page.evaluate("LyricsStudio.loadLyrics({key:'t:hang', title:'Hang Song', artist:'Nobody', duration:100})")
        ok = wait_js(page, "LyricsStudio.r.lyr.status === 'error'", 6000)
        el = time.time() - t0
        note = page.evaluate("LyricsStudio.r.lyr.note")
        check("timeout: lyrics lookup gives up with a clear message", ok and "沒有回應" in note and el < 5, (ok, note, round(el, 2)))
        check("timeout: a timeout is not remembered as 'no lyrics'", "t:hang" not in (page.evaluate("localStorage.getItem('ls.lyricsCache')") or ""))
        page.keyboard.press("l")
        page.wait_for_timeout(300)
        ok = wait_js(page, "(document.querySelector('#results .msg') || {}).textContent?.includes('沒有回應')", 5000)
        check("timeout: search dialog says lrclib did not answer", ok, page.inner_text("#results"))
        page.click("#searchClose")
        state["lrclib_hang"] = False
        for r in state.pop("hung", []):
            try: r.abort()
            except Exception: pass  # the page already gave up on it
        page.evaluate("Lyrics.timeoutMs = 10000; LyricsStudio.loadLyrics(LyricsStudio.track)")
        page.wait_for_timeout(300)

        # ---------- I. import LRC files: checks, encodings, plain text ----------
        hook_toasts(page)
        def put_file(name, data, mime="text/plain"):
            n = len(toasts(page))
            page.set_input_files("#lrcFile", files=[{"name": name, "mimeType": mime, "buffer": data}])
            page.wait_for_timeout(400)
            return n
        before = page.evaluate("LyricsStudio.r.lyr.entries.length")
        n = put_file("cover.lrc", ART, "application/octet-stream")
        check("import: image renamed .lrc is refused", said(page, n, "不是文字檔") and page.evaluate("LyricsStudio.r.lyr.entries.length") == before, toasts(page)[n:])
        n = put_file("big.lrc", b"a" * (1100 * 1024))
        check("import: a 1 MB+ file is refused", said(page, n, "太大"), toasts(page)[n:])
        n = put_file("blank.lrc", b"   \r\n  \r\n")
        check("import: an empty file is refused", said(page, n, "沒有歌詞"), toasts(page)[n:])
        gbk = "[00:01.00]我的你是不了人\n[00:03.50]这是第二行测试歌词\n".encode("gb18030")
        n = put_file("gbk.lrc", gbk)
        g1 = page.evaluate("(() => { const E = LyricsStudio.r.lyr.entries.filter(e => e.type === 'line'); return { s: LyricsStudio.r.lyr.status, a: E[0] && E[0].text, b: E[1] && E[1].text }; })()")
        check("import: GBK file decoded", g1["s"] == "synced" and g1["a"] == "我的你是不了人" and g1["b"] == "这是第二行测试歌词" and said(page, n, "已匯入"), (g1, toasts(page)[n:]))
        big5 = "[00:01.00]我的你是不了人\n[00:03.50]這是第二行測試歌詞\n".encode("big5")
        put_file("big5.lrc", big5)
        b1 = page.evaluate("(() => { const E = LyricsStudio.r.lyr.entries.filter(e => e.type === 'line'); return { a: E[0] && E[0].text, b: E[1] && E[1].text }; })()")
        check("import: Big5 file decoded", b1["a"] == "我的你是不了人" and b1["b"] == "這是第二行測試歌詞", b1)
        n = put_file("plain.txt", "第一行歌詞\n第二行歌詞\n第三行歌詞\n".encode("utf-8"))
        check("import: text without timestamps becomes unsynced lyrics", page.evaluate("LyricsStudio.r.lyr.status") == "plain" and said(page, n, "沒有時間標記"), toasts(page)[n:])
        page.reload()
        page.wait_for_timeout(1200)
        check("import: the imported file is kept after a reload, even for the demo song", page.evaluate("LyricsStudio.r.lyr.status") == "plain")
        page.keyboard.press("l"); page.wait_for_timeout(300)
        page.click("#btnAuto")
        page.wait_for_timeout(400)
        check("import: 'back to automatic' restores the song's own lyrics", page.evaluate("LyricsStudio.r.lyr.status === 'synced' && LyricsStudio.r.lyr.entries.length >= 10"))
        ctx.close()

        # ---------- G. Spotify: stored token expired → refresh → playing track → lyrics via search fallback ----------
        ctx, page = new_page()
        page.goto(BASE)
        page.evaluate("""localStorage.setItem('ls.spotify.clientId', JSON.stringify('0123456789abcdef0123456789abcdef'));
            localStorage.setItem('ls.spotify.token', JSON.stringify({access:'EXPIRED', refresh:'R1', exp: Date.now() + 3600e3}));
            localStorage.setItem('ls.settings', JSON.stringify({source:'spotify', layout:'16:9'}));""")
        state["cp_start"] = time.time()
        page.reload()
        page.wait_for_timeout(3500)
        page.evaluate("LyricsStudio.r.warm = -1e9")
        g = page.evaluate("({t: LyricsStudio.track && LyricsStudio.track.title, a: LyricsStudio.track && LyricsStudio.track.artist, s: LyricsStudio.r.lyr.status, art: !!LyricsStudio.r.artImg, acc: LyricsStudio.r.palette.accent, status: document.getElementById('status').textContent, tok: JSON.parse(localStorage.getItem('ls.spotify.token'))})")
        check("spotify: refreshed after 401", g["tok"]["access"] == "FRESH" and g["tok"]["refresh"] == "R2", g["tok"])
        forms = state.get("token_forms", [])
        check("spotify: refresh request is PKCE style (client_id, no secret)", forms and forms[-1].get("grant_type") == "refresh_token" and forms[-1].get("client_id") == "0123456789abcdef0123456789abcdef" and "client_secret" not in forms[-1], forms)
        check("spotify: track picked up", g["t"] == "Test Song" and g["a"] == "Test Artist", g)
        check("spotify: status says playing", g["status"] == "Spotify 播放中", g["status"])
        check("spotify: album art loaded through CORS", g["art"], g)
        check("spotify: lyrics found via search fallback", g["s"] == "synced", g)
        check("spotify: no seek bar (read-only access)", page.evaluate("document.getElementById('scrub').hidden"))
        print("   lrclib calls:", state["lrclib"][-4:])
        pos = page.evaluate("LyricsStudio.clock.now()")
        check("spotify: clock follows progress", 4 < pos < 12, pos)
        page.wait_for_timeout(1200)
        snap(page, "G1-spotify-16x9.png")
        n_lr = len(state["lrclib"])
        page.reload()
        page.wait_for_timeout(2500)
        check("spotify: lyrics come from the saved cache after a reload (no new lookups)", page.evaluate("LyricsStudio.r.lyr.status") == "synced" and len(state["lrclib"]) == n_lr, (page.evaluate("LyricsStudio.r.lyr.status"), state["lrclib"][n_lr:]))

        # ---------- S. two tabs: only one polls Spotify; a visible tab takes over from a hidden one ----------
        page.evaluate("localStorage.setItem('ls.spotify.token', JSON.stringify({access:'GOOD', refresh:'R1', exp: Date.now() + 3600e3}))")
        page.reload()
        sp_by = {"A": 0, "B": 0}
        sp_log = []
        def counter(tag):
            def f(r):
                if r.url.startswith("https://api.spotify.com/") and r.method == "GET":
                    sp_by[tag] += 1; sp_log.append((tag, round(time.time() - T0, 2)))
            return f
        page.on("request", counter("A"))
        ok = wait_js(page, "LyricsStudio.sources.spotify.leader === true", 4000)
        check("tabs: first tab leads", ok)
        n_lr = len(state["lrclib"])
        pb = watch(ctx.new_page())
        pb.on("request", counter("B"))
        pb.goto(BASE)
        pb.wait_for_timeout(2500)
        sp_by["A"] = sp_by["B"] = 0
        pb.wait_for_timeout(3000)
        s1 = pb.evaluate("({lead: LyricsStudio.sources.spotify.leader, t: LyricsStudio.track && LyricsStudio.track.title, st: document.getElementById('status').textContent, ly: LyricsStudio.r.lyr.status})")
        check("tabs: second tab waits and gets the track from the first", s1["lead"] is False and s1["t"] == "Test Song" and s1["st"] == "Spotify 播放中" and s1["ly"] == "synced", s1)
        check("tabs: only one tab calls Spotify", sp_by["B"] == 0 and 2 <= sp_by["A"] <= 4, dict(sp_by))
        check("tabs: second tab reuses the saved lyrics", len(state["lrclib"]) == n_lr, state["lrclib"][n_lr:])
        page.evaluate("""Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });""")
        ok = wait_js(pb, "LyricsStudio.sources.spotify.leader === true", 6000)
        check("tabs: visible tab takes over from a hidden leader", ok and page.evaluate("LyricsStudio.sources.spotify.leader") is False)
        pb.wait_for_timeout(500)
        sp_by["A"] = sp_by["B"] = 0
        pb.wait_for_timeout(2500)
        check("tabs: after the hand-over only the visible tab polls", sp_by["A"] == 0 and sp_by["B"] >= 1, (dict(sp_by), sp_log[-8:]))
        check("tabs: the hidden tab still follows along", page.evaluate("LyricsStudio.track && LyricsStudio.track.title") == "Test Song")
        pb.close()
        ok = wait_js(page, "LyricsStudio.sources.spotify.leader === true", 5000)
        check("tabs: closing the leader hands polling back", ok)
        ctx.close()

        # ---------- G3. Spotify idle states: nothing playing, access denied ----------
        ctx, page = new_page()
        page.goto(BASE)
        page.evaluate("""localStorage.setItem('ls.spotify.clientId', JSON.stringify('0123456789abcdef0123456789abcdef'));
            localStorage.setItem('ls.spotify.token', JSON.stringify({access:'NOPLAY', refresh:'R1', exp: Date.now() + 3600e3}));
            localStorage.setItem('ls.settings', JSON.stringify({source:'spotify'}));""")
        page.reload()
        page.wait_for_timeout(2000)
        n = page.evaluate("({st: document.getElementById('status').textContent, note: LyricsStudio.r.lyr.note, s: LyricsStudio.r.lyr.status})")
        check("spotify idle: nothing playing", n["st"] == "Spotify 待命" and "沒有在播放" in n["note"] and n["s"] == "idle", n)
        page.evaluate("localStorage.setItem('ls.spotify.token', JSON.stringify({access:'DENIED', refresh:'R1', exp: Date.now() + 3600e3}))")
        page.reload()
        page.wait_for_timeout(2000)
        d = page.evaluate("({st: document.getElementById('status').textContent, note: LyricsStudio.r.lyr.note, sticky: document.getElementById('toast').classList.contains('sticky')})")
        check("spotify idle: 403 explains Premium / user list", d["st"] == "Spotify 拒絕存取" and "Premium" in toast(page) and d["sticky"], (d, toast(page)))
        ctx.close()

        # ---------- G2. Spotify OAuth redirect handling ----------
        ctx, page = new_page()
        page.goto(BASE)
        page.evaluate("""localStorage.setItem('ls.spotify.clientId', JSON.stringify('0123456789abcdef0123456789abcdef'));
            localStorage.setItem('ls.spotify.pkce', JSON.stringify({verifier:'VERIFIER123', state:'S1', redirect:'http://127.0.0.1:8888/'}));""")
        page.goto(BASE + "?code=AUTHCODE&state=S1")
        page.wait_for_timeout(1500)
        r2 = page.evaluate("({url: location.href, tok: JSON.parse(localStorage.getItem('ls.spotify.token')||'null'), pk: localStorage.getItem('ls.spotify.pkce'), src: LyricsStudio.S.source})")
        last = state.get("token_forms", [{}])[-1]
        check("oauth: code exchanged with verifier", last.get("grant_type") == "authorization_code" and last.get("code_verifier") == "VERIFIER123" and last.get("redirect_uri") == "http://127.0.0.1:8888/", last)
        check("oauth: token stored, URL cleaned, pkce removed", r2["tok"] and r2["tok"]["access"] == "FRESH" and r2["url"] == BASE and r2["pk"] is None and r2["src"] == "spotify", r2)
        page.evaluate("LyricsStudio.openSpotify()")
        page.wait_for_timeout(400)
        check("spotify dialog: redirect URI shown", page.inner_text("#spRedirect") == "http://127.0.0.1:8888/", page.inner_text("#spRedirect"))
        check("spotify dialog: no address warning on 127.0.0.1", page.evaluate("document.getElementById('spWarn').hidden"))
        page.screenshot(path=str(OUT / "G2-spotify-dialog.png"))
        ctx.close()

        # ---------- H. YouTube with a fake player ----------
        ctx, page = new_page(init=FAKE_YT)
        page.goto(BASE)
        page.wait_for_timeout(600)
        page.click("button[data-src=youtube]")
        page.wait_for_timeout(400)
        check("youtube: link dialog opens", page.evaluate("document.getElementById('dlgYoutube').open"))
        page.screenshot(path=str(OUT / "H0-youtube-dialog.png"))
        page.fill("#ytUrl", "https://music.youtube.com/watch?v=abcdefghijk&list=RDAMVM")
        page.click("#ytForm button[type=submit]")
        page.wait_for_timeout(3500)
        page.evaluate("LyricsStudio.r.warm = -1e9")
        h = page.evaluate("({t: LyricsStudio.track && LyricsStudio.track.title, a: LyricsStudio.track && LyricsStudio.track.artist, k: LyricsStudio.track && LyricsStudio.track.key, s: LyricsStudio.r.lyr.status, art: !!LyricsStudio.r.artImg, crop: LyricsStudio.r.artCrop, card: !document.getElementById('ytcard').hidden})")
        check("youtube: title parsed from video title", h["t"] == "Test Song" and h["a"] == "Test Artist", h)
        check("youtube: key from video id", h["k"] == "yt:abcdefghijk", h)
        check("youtube: player card visible", h["card"], h)
        check("youtube: lyrics synced", h["s"] == "synced", h)
        check("youtube: letterboxed thumbnail cropped to the picture", h["art"] and h["crop"] and abs(h["crop"][1] - 45) < 1 and abs(h["crop"][3] - 270) < 1, h)
        check("youtube: player unmuted at the saved volume", page.evaluate("__yt.vol === 100 && __yt.muted === false"))
        page.keyboard.press("Space")
        page.wait_for_timeout(300)
        check("youtube: space pauses", page.evaluate("LyricsStudio.clock.playing") is False)
        page.keyboard.press("Space")
        wake(page)
        check("youtube: seek bar and volume shown", page.evaluate("!document.getElementById('scrub').hidden && !document.getElementById('volWrap').hidden"))
        page.fill("#vol", "40")
        page.wait_for_timeout(150)
        check("youtube: volume slider sets the player and is remembered", page.evaluate("__yt.vol === 40 && JSON.parse(localStorage.getItem('ls.yt.vol')) === 40"))
        page.fill("#seek", "250")
        page.wait_for_timeout(300)
        check("youtube: seek bar jumps the player", abs(page.evaluate("__yt.getCurrentTime()") - 50) < 0.6, page.evaluate("__yt.getCurrentTime()"))
        page.evaluate("document.activeElement.blur()")  # on the focused slider the arrows move the slider itself
        t_before = page.evaluate("__yt.getCurrentTime()")
        page.keyboard.press("ArrowRight")
        jump = page.evaluate("__yt.getCurrentTime()") - t_before
        check("youtube: arrow key skips 5 s", 4.9 < jump < 5.8, jump)
        page.wait_for_timeout(600)
        snap(page, "H1-youtube-fit.png")
        page.screenshot(path=str(OUT / "H2-youtube-ui.png"))
        # manual search: pick → preview → apply
        page.keyboard.press("l")
        page.wait_for_timeout(1500)
        n = page.evaluate("document.querySelectorAll('#results .res').length")
        check("search dialog: shortcut key not typed into the box", page.input_value("#q") == "Test Song Test Artist", page.input_value("#q"))
        check("search dialog: results listed", n == 3, n)
        page.screenshot(path=str(OUT / "H3-search-dialog.png"))
        page.click("#results .res >> nth=0")
        page.wait_for_timeout(300)
        pvw = page.evaluate("({vis: !document.getElementById('preview').hidden, list: document.getElementById('searchList').hidden, n: document.querySelectorAll('#pvLines li').length, kind: document.getElementById('pvKind').textContent, first: (document.querySelector('#pvLines li')||{}).textContent, st: LyricsStudio.r.lyr.status})")
        check("search: picking a result shows a preview first", pvw["vis"] and pvw["list"] and pvw["n"] >= 3 and pvw["kind"] == "同步歌詞" and pvw["first"] == "Placeholder line number one", pvw)
        page.screenshot(path=str(OUT / "H3b-search-preview.png"))
        page.click("#pvBack")
        page.wait_for_timeout(150)
        check("search: back returns to the results", page.evaluate("document.getElementById('preview').hidden && !document.getElementById('searchList').hidden"))
        page.click("#results .res >> nth=0")
        page.wait_for_timeout(200)
        page.click("#pvApply")
        page.wait_for_timeout(300)
        check("search: applying stores the pick", page.evaluate("LyricsStudio.r.lyr.status") == "synced" and page.evaluate("JSON.parse(localStorage.getItem('ls.lyricsPick.yt:abcdefghijk'))") == 12 and not page.evaluate("document.getElementById('dlgSearch').open"))
        page.keyboard.press("l"); page.wait_for_timeout(500)
        page.click("#btnNone")
        page.wait_for_timeout(300)
        check("search: 'no lyrics for this song' sticks", page.evaluate("LyricsStudio.r.lyr.status") == "off" and page.evaluate("JSON.parse(localStorage.getItem('ls.lyricsPick.yt:abcdefghijk'))") == "none")
        snap(page, "H3c-lyrics-off.png")
        page.keyboard.press("l"); page.wait_for_timeout(500)
        page.click("#btnAuto")
        ok = wait_js(page, "LyricsStudio.r.lyr.status === 'synced'", 4000)
        check("search: back to automatic finds lyrics again", ok and page.evaluate("localStorage.getItem('ls.lyricsPick.yt:abcdefghijk')") is None)
        # record dialog look
        page.keyboard.press("r")
        page.wait_for_timeout(400)
        page.check("#recForm input[value=system]")
        page.wait_for_timeout(200)
        check("record dialog: YouTube hint says to share this tab", "這個分頁" in page.inner_text("#recHint"), page.inner_text("#recHint"))
        page.screenshot(path=str(OUT / "H4-record-dialog.png"))
        page.keyboard.press("Escape")
        page.click("#btnSettings")
        page.wait_for_timeout(300)
        page.screenshot(path=str(OUT / "H5-settings-dialog.png"))
        ctx.close()

        # ---------- H6. karaoke upload titled "Title - Artist (伴奏版)" ----------
        ctx, page = new_page(init=FAKE_YT)
        page.goto(BASE)
        page.wait_for_timeout(600)
        page.evaluate("window.__ytTitle = 'Test Song - Test Artist (伴奏版)'; window.__ytAuthor = 'Test Artist'; LyricsStudio.setSource('youtube')")
        page.wait_for_timeout(300)
        page.fill("#ytUrl", "https://youtu.be/kkkkkkkkkkk")
        page.click("#ytForm button[type=submit]")
        ok = wait_js(page, "LyricsStudio.r.lyr.status === 'synced'", 6000)
        k = page.evaluate("({t: LyricsStudio.track.title, a: LyricsStudio.track.artist, inst: LyricsStudio.track.inst})")
        check("karaoke video: original song's lyrics, names the right way round", ok and k == {"t": "Test Song", "a": "Test Artist", "inst": True}, (ok, k))
        ctx.close()

        # ---------- P. phone screen: YouTube card at the smallest allowed size, controls fit ----------
        ctx, page = new_page(390, 844, init=FAKE_YT)
        page.goto(BASE)
        page.wait_for_timeout(600)
        page.evaluate("LyricsStudio.setSource('youtube')")
        page.wait_for_timeout(300)
        page.fill("#ytUrl", "https://youtu.be/abcdefghijk")
        page.click("#ytForm button[type=submit]")
        page.wait_for_timeout(3000)
        ph = page.evaluate("""(() => { const box = el => { const r = document.querySelector(el).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
            return { card: box('#ytplayer'), dock: box('.dock'), scrub: box('#scrub'), vw: innerWidth }; })()""")
        check("phone: YouTube player is 200 × 200", ph["card"][2] == 200 and ph["card"][3] == 200, ph)
        check("phone: dock and seek bar fit the screen", ph["dock"][0] >= 0 and ph["dock"][0] + ph["dock"][2] <= ph["vw"] and ph["scrub"][0] >= 0 and ph["scrub"][0] + ph["scrub"][2] <= ph["vw"], ph)
        wake(page); page.wait_for_timeout(200)
        page.screenshot(path=str(OUT / "P1-phone-youtube.png"))
        ctx.close()

        # ---------- N. opened the wrong way: file:// and localhost ----------
        ctx, page = new_page()
        page.goto((ROOT / "index.html").as_uri())
        page.wait_for_timeout(1200)
        fb = page.evaluate("({vis: !document.getElementById('envBar').hidden, msg: document.getElementById('envMsg').textContent, href: document.getElementById('envLink').href})")
        check("file://: banner explains and links to the live site", fb["vis"] and "start.bat" in fb["msg"] and fb["href"] == LIVE_URL, fb)
        wake(page); page.wait_for_timeout(200)
        page.screenshot(path=str(OUT / "N1-file-banner.png"))
        page.click("button[data-src=spotify]")
        page.wait_for_timeout(300)
        check("file://: Spotify dialog warns before login", not page.evaluate("document.getElementById('spWarn').hidden"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        page.click("#envClose")
        check("file://: banner can be dismissed", page.evaluate("document.getElementById('envBar').hidden"))
        page.goto("http://localhost:8888/")
        page.wait_for_timeout(1000)
        lb = page.evaluate("({vis: !document.getElementById('envBar').hidden, msg: document.getElementById('envMsg').textContent, href: document.getElementById('envLink').href})")
        check("localhost: banner offers the 127.0.0.1 address", lb["vis"] and "127.0.0.1" in lb["msg"] and lb["href"].startswith("http://127.0.0.1:8888/"), lb)
        ctx.close()

        # ---------- J. idle hides UI ----------
        ctx, page = new_page()
        page.goto(BASE)
        page.mouse.move(300, 300)
        page.wait_for_timeout(3200)
        check("idle: interface hides", page.evaluate("document.body.classList.contains('idle')"))
        page.mouse.move(320, 320)
        page.wait_for_timeout(200)
        check("idle: wakes on mouse move", not page.evaluate("document.body.classList.contains('idle')"))
        page.click("#btnTheme")
        page.wait_for_timeout(3200)
        check("idle: stays awake while a menu is open", not page.evaluate("document.body.classList.contains('idle')"))
        ctx.close()
        browser.close()
finally:
    srv.terminate()

noise = [e for e in errors if "net::ERR_FAILED" not in e and "Failed to load resource" not in e]
check("no page errors", not noise, noise[:8])
fails = [r for r in results if not r[1]]
print(f"\n{len(results) - len(fails)}/{len(results)} checks passed")
sys.exit(1 if fails else 0)
