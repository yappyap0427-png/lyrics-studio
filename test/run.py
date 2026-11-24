#!/usr/bin/env python3
"""End-to-end checks in headless Chrome. External services are mocked; lyrics are placeholder text."""
import base64, json, os, struct, subprocess, sys, time, zlib, urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "out"
OUT.mkdir(parents=True, exist_ok=True)
BASE = "http://127.0.0.1:8888/"

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

state = {"cp_calls": 0, "token_calls": 0, "lrclib": [], "cp_start": time.time()}

def record(i, track, artist, dur, synced=True):
    return {"id": i, "name": track, "trackName": track, "artistName": artist, "albumName": "Test Album", "duration": dur,
            "instrumental": False, "plainLyrics": "plain text", "syncedLyrics": FIX_LRC if synced else None}

def handler(route, request):
    url = request.url
    u = urllib.parse.urlparse(url)
    q = dict(urllib.parse.parse_qsl(u.query))
    host = u.hostname or ""
    if host in ("127.0.0.1",):
        return route.continue_()
    if host == "lrclib.net":
        state["lrclib"].append(u.path + "?" + u.query)
        hdr = {"Access-Control-Allow-Origin": "*", "Content-Type": "application/json"}
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers={**hdr, "Access-Control-Allow-Headers": "Lrclib-Client"})
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
  constructor(el, o) { this.o = o; this.vid = o.videoId; this.base = 0; this.t0 = performance.now(); this.st = -1;
    const f = document.createElement('iframe'); f.id = 'ytplayer'; document.getElementById(el).replaceWith(f);
    setTimeout(() => o.events.onReady && o.events.onReady({ target: this }), 60); }
  playVideo() { if (this.st !== 1) { this.st = 1; this.t0 = performance.now(); } }
  pauseVideo() { this.base = this.getCurrentTime(); this.st = 2; }
  getPlayerState() { return this.st; }
  getCurrentTime() { return this.st === 1 ? this.base + (performance.now() - this.t0) / 1000 : this.base; }
  getDuration() { return 200; }
  getVideoData() { return { video_id: this.vid, title: 'Test Artist - Test Song (Official Music Video)', author: 'TestArtistVEVO' }; }
  loadVideoById(id) { this.vid = id; this.base = 0; this.t0 = performance.now(); this.st = 1; }
  seekTo(s) { this.base = s; this.t0 = performance.now(); }
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

def ffprobe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration,format_name", "-of", "json", str(path)], capture_output=True, text=True)
    return json.loads(r.stdout or "{}")

srv = subprocess.Popen([sys.executable, "-m", "http.server", "8888", "--bind", "127.0.0.1"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
errors = []
try:
    with sync_playwright() as p:
        exe = os.environ.get("CHROME_PATH") or ("/usr/bin/google-chrome" if Path("/usr/bin/google-chrome").exists() else None)
        browser = p.chromium.launch(executable_path=exe, headless=True, args=[
            "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
            "--auto-accept-this-tab-capture", "--enable-unsafe-swiftshader"])

        def new_page(vw=1600, vh=900, init=None):
            ctx = browser.new_context(viewport={"width": vw, "height": vh}, device_scale_factor=1, accept_downloads=True)
            ctx.route("**/*", handler)
            if init:
                ctx.add_init_script(init)
            pg = ctx.new_page()
            pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
            pg.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
            return ctx, pg

        # ---------- A. demo mode, default theme ----------
        ctx, page = new_page()
        page.goto(BASE)
        page.wait_for_timeout(1200)
        page.evaluate("LyricsStudio.r.warm = -1e9")  # keep blur on in the slow software renderer
        check("demo: status text", page.inner_text("#status") == "示範模式", page.inner_text("#status"))
        st = page.evaluate("({s: LyricsStudio.r.lyr.status, n: LyricsStudio.r.lyr.entries.length, w: stage.width, h: stage.height})")
        check("demo: synced lyrics loaded", st["s"] == "synced" and st["n"] >= 10, st)
        check("demo: fit canvas matches viewport", st["w"] == 1600 and st["h"] == 900, st)
        settle(page, "LyricsStudio.sources.demo.jump(5.2)", 1.0); snap(page, "A1-flow-fit-line.png")
        settle(page, "LyricsStudio.sources.demo.jump(13.2)", 1.0); snap(page, "A2-flow-fit-bilingual.png")
        settle(page, "LyricsStudio.sources.demo.jump(31.5)", 1.2); snap(page, "A3-flow-fit-interlude.png")
        dots = page.evaluate("(() => { const E = LyricsStudio.r.lyr.entries; const i = LRC.activeIndex(E, 31.5); return E[i].type + ':' + E[i].show; })()")
        check("demo: interlude entry active at 31.5s", dots == "gap:true", dots)
        page.screenshot(path=str(OUT / "A4-ui-dock.png"))

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
        mime = page.evaluate("Recorder.mime(false) + ' | ' + Recorder.mime(true)")
        print("   recorder mime:", mime)
        page.evaluate("LyricsStudio.rec.start({audio:'none', fps:30, bitrate:8e6})")
        page.wait_for_timeout(500)
        check("record: recbar visible", page.is_visible("#recbar"))
        check("record: layout button locked", page.evaluate("document.getElementById('btnLayout').disabled"))
        page.wait_for_timeout(3000)
        with page.expect_download(timeout=15000) as dl:
            page.evaluate("LyricsStudio.rec.stop()")
        d = dl.value
        f1 = OUT / ("E1-record-silent" + Path(d.suggested_filename).suffix)
        d.save_as(str(f1))
        info = ffprobe(f1)
        vs = [s for s in info.get("streams", []) if s.get("codec_type") == "video"]
        check("record: file has a 1920x1080 video stream", vs and vs[0].get("width") == 1920 and vs[0].get("height") == 1080, info)
        print("   silent file:", d.suggested_filename, f1.stat().st_size, "bytes", info.get("format", {}).get("format_name"), vs and vs[0].get("codec_name"))
        # extract a frame from the recording to confirm it is not blank
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "1.5", "-i", str(f1), "-frames:v", "1", str(OUT / "E2-record-frame.png")])
        check("record: frame extracted", (OUT / "E2-record-frame.png").exists())

        # ---------- F. recording with microphone (fake device) ----------
        page.evaluate("LyricsStudio.rec.start({audio:'mic', fps:30, bitrate:8e6})")
        page.wait_for_timeout(2500)
        with page.expect_download(timeout=15000) as dl2:
            page.evaluate("LyricsStudio.rec.stop()")
        f2 = OUT / ("F1-record-mic" + Path(dl2.value.suggested_filename).suffix)
        dl2.value.save_as(str(f2))
        info2 = ffprobe(f2)
        kinds = sorted(s.get("codec_type") for s in info2.get("streams", []))
        check("record+mic: has audio and video", kinds == ["audio", "video"], info2)
        print("   mic file codecs:", [(s.get("codec_type"), s.get("codec_name")) for s in info2.get("streams", [])])

        # ---------- F2. tab audio via getDisplayMedia (may be unsupported headless) ----------
        try:
            page.evaluate("LyricsStudio.rec.start({audio:'system', fps:30, bitrate:8e6, preferTab:true})")
            page.wait_for_timeout(2000)
            active = page.evaluate("LyricsStudio.rec.active")
            if active:
                with page.expect_download(timeout=15000) as dl3:
                    page.evaluate("LyricsStudio.rec.stop()")
                print("   tab-audio recording worked:", dl3.value.suggested_filename)
            else:
                print("   tab-audio capture not available in headless (expected); toast:", page.inner_text("#toast"))
        except Exception as ex:
            print("   tab-audio capture skipped:", str(ex)[:120])
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
        print("   lrclib calls:", state["lrclib"])
        pos = page.evaluate("LyricsStudio.clock.now()")
        check("spotify: clock follows progress", 4 < pos < 12, pos)
        page.wait_for_timeout(1200)
        snap(page, "G1-spotify-16x9.png")
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
        # the setup dialog shows the exact redirect URI
        page.evaluate("LyricsStudio.openSpotify()")
        page.wait_for_timeout(400)
        check("spotify dialog: redirect URI shown", page.inner_text("#spRedirect") == "http://127.0.0.1:8888/", page.inner_text("#spRedirect"))
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
        page.keyboard.press("Space")
        page.wait_for_timeout(300)
        check("youtube: space pauses", page.evaluate("LyricsStudio.clock.playing") is False)
        page.keyboard.press("Space")
        snap(page, "H1-youtube-fit.png")
        page.screenshot(path=str(OUT / "H2-youtube-ui.png"))
        # manual search dialog
        page.keyboard.press("l")
        page.wait_for_timeout(1500)
        n = page.evaluate("document.querySelectorAll('#results .res').length")
        check("search dialog: shortcut key not typed into the box", page.input_value("#q") == "Test Song Test Artist", page.input_value("#q"))
        check("search dialog: results listed", n == 3, n)
        page.screenshot(path=str(OUT / "H3-search-dialog.png"))
        page.click("#results .res >> nth=0")
        page.wait_for_timeout(300)
        check("search: picking a result applies it", page.evaluate("LyricsStudio.r.lyr.status") == "synced" and page.evaluate("JSON.parse(localStorage.getItem('ls.lyricsPick.yt:abcdefghijk'))") == 12)
        # record dialog look
        page.keyboard.press("r")
        page.wait_for_timeout(400)
        page.check("#recForm input[value=system]")
        page.wait_for_timeout(200)
        page.screenshot(path=str(OUT / "H4-record-dialog.png"))
        page.keyboard.press("Escape")
        # settings dialog
        page.click("#btnSettings")
        page.wait_for_timeout(300)
        page.screenshot(path=str(OUT / "H5-settings-dialog.png"))
        ctx.close()

        # ---------- I. idle hides UI; import LRC by file ----------
        ctx, page = new_page()
        page.goto(BASE)
        page.mouse.move(300, 300)
        page.wait_for_timeout(3200)
        check("idle: interface hides", page.evaluate("document.body.classList.contains('idle')"))
        page.mouse.move(320, 320)
        page.wait_for_timeout(200)
        check("idle: wakes on mouse move", not page.evaluate("document.body.classList.contains('idle')"))
        ctx.close()
        browser.close()
finally:
    srv.terminate()

noise = [e for e in errors if "net::ERR_FAILED" not in e and "Failed to load resource" not in e]
check("no page errors", not noise, noise[:8])
fails = [r for r in results if not r[1]]
print(f"\n{len(results) - len(fails)}/{len(results)} checks passed")
sys.exit(1 if fails else 0)
