/* ---------- playback clock: smooth between sparse position reports ---------- */
class Clock {
  constructor() { this.pos = 0; this.at = performance.now(); this.playing = false; }
  now(ts = performance.now()) { return this.pos + (this.playing ? (ts - this.at) / 1000 : 0); }
  sync(pos, playing, ts = performance.now(), hard = false) {
    const predicted = this.now(ts);
    const diff = pos - predicted;
    if (!hard && this.playing && playing && Math.abs(diff) < 0.6) {
      this.pos = predicted + diff * 0.35; // ease toward the report instead of jumping
    } else {
      this.pos = pos;
    }
    this.at = ts;
    this.playing = playing;
  }
}

/* ---------- Spotify: Web API, Authorization Code + PKCE (no secret needed) ---------- */
class SpotifySource {
  constructor(app) { this.app = app; this.active = false; this.timer = 0; this.loop = 0; this.warned403 = false; }
  get clientId() { return Store.get('spotify.clientId', ''); }
  get token() { return Store.get('spotify.token', null); }
  redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }
  originProblem() {
    if (location.protocol === 'file:') return 'file';
    if (location.hostname === 'localhost') return 'localhost';
    if (location.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(location.hostname)) return 'http';
    return null;
  }
  async login(clientId) {
    Store.set('spotify.clientId', clientId);
    const verifier = randomString(64);
    const challenge = await sha256b64url(verifier);
    const state = randomString(16);
    Store.set('spotify.pkce', { verifier, state, redirect: this.redirectUri() });
    const p = new URLSearchParams({
      response_type: 'code', client_id: clientId,
      scope: 'user-read-currently-playing user-read-playback-state',
      code_challenge_method: 'S256', code_challenge: challenge,
      redirect_uri: this.redirectUri(), state,
    });
    location.assign('https://accounts.spotify.com/authorize?' + p.toString());
  }
  async handleRedirect() {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return false;
    const pk = Store.get('spotify.pkce', null);
    history.replaceState(null, '', location.pathname);
    if (q.get('error')) { toast('Spotify 沒有授權（' + q.get('error') + '），可以再按一次連接', 6000); return true; }
    if (!pk || pk.state !== q.get('state')) { toast('登入流程對不上，請重新連接 Spotify', 6000); return true; }
    try {
      const body = new URLSearchParams({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: pk.redirect, client_id: this.clientId, code_verifier: pk.verifier });
      const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast('Spotify 登入失敗：' + (j.error_description || j.error || r.status), 7000); return true; }
      this.saveToken(j);
      Store.del('spotify.pkce');
      toast('已連接 Spotify');
    } catch (e) { toast('連不到 Spotify 登入伺服器，檢查網路後再試', 6000); }
    return true;
  }
  saveToken(j) {
    const prev = this.token || {};
    Store.set('spotify.token', { access: j.access_token, refresh: j.refresh_token || prev.refresh, exp: Date.now() + ((j.expires_in || 3600) - 60) * 1000 });
  }
  async refresh() {
    const t = this.token;
    if (!t || !t.refresh) throw new Error('NO_REFRESH');
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: this.clientId });
    const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (j.error === 'invalid_grant' || j.error === 'invalid_client') Store.del('spotify.token');
      throw new Error('REFRESH_FAILED');
    }
    this.saveToken(j);
    return this.token.access;
  }
  async accessToken() {
    const t = this.token;
    if (!t) return null;
    if (Date.now() < t.exp) return t.access;
    return this.refresh();
  }
  logout() { Store.del('spotify.token'); this.app.onIdle('spotify-login'); }
  start() { this.active = true; this.warned403 = false; const id = ++this.loop; this.poll(id); }
  stop() { this.active = false; this.loop++; clearTimeout(this.timer); }
  async poll(id) {
    if (!this.active || id !== this.loop) return;
    let next = 1000;
    try {
      if (!this.token) { this.app.onIdle('spotify-login'); next = 3000; }
      else {
        let tok = await this.accessToken();
        const t0 = performance.now();
        const url = 'https://api.spotify.com/v1/me/player/currently-playing';
        let r = await fetch(url, { headers: { Authorization: 'Bearer ' + tok } });
        if (r.status === 401) { tok = await this.refresh(); r = await fetch(url, { headers: { Authorization: 'Bearer ' + tok } }); }
        const t1 = performance.now();
        if (id !== this.loop) return;
        if (r.status === 204 || r.status === 202) { this.app.onIdle('spotify-nothing'); next = 2500; }
        else if (r.status === 429) {
          next = (parseFloat(r.headers.get('Retry-After')) || 5) * 1000 + 500;
          this.app.setStatus('Spotify 請求太頻繁，稍等一下');
        } else if (r.status === 403) {
          const j = await r.json().catch(() => ({}));
          if (!this.warned403) {
            this.warned403 = true;
            toast('Spotify 拒絕存取：' + ((j.error && j.error.message) || '403') + '。開發模式需要 App 擁有者有 Premium。', 9000);
          }
          this.app.onIdle('spotify-denied');
          next = 15000;
        } else if (r.ok) {
          const j = await r.json();
          if (!j || !j.item) {
            this.app.onIdle(j && j.currently_playing_type === 'ad' ? 'spotify-ad' : j && j.currently_playing_type === 'episode' ? 'spotify-episode' : 'spotify-nothing');
            next = 2500;
          } else {
            const it = j.item;
            const track = {
              key: 'sp:' + (it.id || it.uri),
              title: it.name || '',
              artist: (it.artists || []).map(a => a.name).join(', '),
              album: (it.album && it.album.name) || '',
              duration: (it.duration_ms || 0) / 1000,
              art: pickImage(it.album && it.album.images),
              source: 'spotify',
            };
            const pos = (j.progress_ms || 0) / 1000 + (j.is_playing ? (t1 - t0) / 2000 : 0);
            this.app.onPlayback(track, pos, !!j.is_playing, t1);
            next = j.is_playing ? 1000 : 2000;
          }
        } else { this.app.setStatus('Spotify 回應錯誤 ' + r.status); next = 4000; }
      }
    } catch (e) {
      console.warn('[spotify]', e);
      if (e.message === 'NO_REFRESH' || e.message === 'REFRESH_FAILED') {
        if (!this.token) this.app.onIdle('spotify-login'); else this.app.setStatus('Spotify 重新登入中…');
      } else this.app.setStatus('連不到 Spotify，重試中…');
      next = 4000;
    }
    if (document.hidden) next = Math.max(next, 4000);
    if (this.active && id === this.loop) this.timer = setTimeout(() => this.poll(id), next);
  }
}
function pickImage(imgs) {
  if (!imgs || !imgs.length) return null;
  return imgs.slice().sort((a, b) => Math.abs((a.width || 640) - 640) - Math.abs((b.width || 640) - 640))[0].url;
}

/* ---------- YouTube / YouTube Music: song plays in an embedded player ---------- */
function parseVideoTitle(title, author) {
  let t = String(title || '').trim();
  let a = String(author || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s*(official|官方)(\s*(artist\s*)?(channel|頻道))?$/i, '').trim();
  const NOISE = /(official|music\s*video|lyric|lyrics|audio|visuali[sz]er|\bmv\b|m\/v|\bhd\b|\b4k\b|live|官方|完整版|歌詞|動態|高音質|中字|字幕)/i;
  t = t.replace(/[(\[【（〔][^)\]】）〕]*[)\]】）〕]/g, m => (NOISE.test(m) ? '' : m)).replace(/\s{2,}/g, ' ').trim();
  let m = t.match(/^(.+?)\s+[-–—|]\s+(.+)$/);
  if (m) { a = m[1].trim(); t = m[2].trim(); }
  else {
    m = t.match(/^(.+?)\s*[《『「【](.+?)[》』」】]/);
    if (m) { a = m[1].trim(); t = m[2].trim(); }
  }
  t = t.replace(/\s+(official\s*)?(music\s*video|mv|m\/v)$/i, '').replace(/["“”]/g, '').trim();
  return { title: t, artist: a };
}

class YouTubeSource {
  constructor(app) { this.app = app; this.player = null; this.ready = false; this.videoId = null; this.track = null; this.active = false; this.timer = 0; this.lastT = -1; this.lastPlaying = null; }
  static parseId(input) {
    const s = String(input || '').trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    try {
      const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
      if (/(^|\.)youtu\.be$/i.test(u.hostname)) return u.pathname.slice(1, 12) || null;
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}/.test(v)) return v.slice(0, 11);
      const m = u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    } catch (e) { /* not a URL */ }
    return null;
  }
  loadApi() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (this.apiP) return this.apiP;
    this.apiP = new Promise((res, rej) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); res(); };
      const sc = document.createElement('script');
      sc.src = 'https://www.youtube.com/iframe_api';
      sc.onerror = () => { this.apiP = null; rej(new Error('YT_API')); };
      document.head.appendChild(sc);
      setTimeout(() => { if (!(window.YT && window.YT.Player)) { this.apiP = null; rej(new Error('YT_API')); } }, 15000);
    });
    return this.apiP;
  }
  async play(input) {
    const id = YouTubeSource.parseId(input);
    if (!id) { toast('看不懂這個連結，請貼 YouTube 或 YouTube Music 的歌曲網址', 5000); return false; }
    this.videoId = id;
    Store.set('yt.last', String(input).trim());
    this.track = null;
    try { await this.loadApi(); } catch (e) { toast('載入不了 YouTube 播放器，檢查網路後再試', 6000); return false; }
    this.app.showYtCard(true);
    if (this.player && this.ready) this.player.loadVideoById(id);
    else if (!this.player) {
      this.player = new YT.Player('ytplayer', {
        width: 356, height: 200, videoId: id,
        playerVars: { autoplay: 1, playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady: () => { this.ready = true; try { this.player.playVideo(); } catch (e) { /* ignore */ } },
          onError: e => this.onErr(e),
        },
      });
    }
    return true;
  }
  onErr(e) {
    const c = e && e.data;
    const msg = c === 2 ? '這個影片網址不正確'
      : c === 5 ? '播放器出錯，換一首試試'
      : c === 100 ? '找不到這個影片，可能被刪除或設成私人'
      : c === 101 || c === 150 ? '版權方不允許在其他網站播放這支影片，換一個版本試試（例如 YouTube Music 的歌曲連結）'
      : c === 153 ? '播放器拿不到網址來源，請用 start.bat 開啟程式'
      : '播放失敗（錯誤 ' + c + '）';
    toast(msg, 8000);
  }
  start() {
    this.active = true;
    if (this.player) this.app.showYtCard(true);
    if (!this.videoId) this.app.onIdle('youtube-empty');
    this.tick();
  }
  stop() {
    this.active = false;
    clearTimeout(this.timer);
    try { if (this.player && this.ready) this.player.pauseVideo(); } catch (e) { /* ignore */ }
    this.app.showYtCard(false);
  }
  tick() {
    if (!this.active) return;
    const p = this.player;
    if (p && this.ready && typeof p.getCurrentTime === 'function') {
      try {
        const st = p.getPlayerState();
        const t = p.getCurrentTime() || 0;
        const playing = st === 1;
        const d = p.getVideoData ? p.getVideoData() : null;
        const dur = p.getDuration ? p.getDuration() : 0;
        if (d && d.video_id && d.title && dur > 0 && (!this.track || this.track.vid !== d.video_id)) {
          const meta = parseVideoTitle(d.title, d.author);
          this.track = {
            key: 'yt:' + d.video_id, vid: d.video_id,
            title: meta.title || d.title, artist: meta.artist || d.author || '', album: '',
            duration: dur,
            art: ['https://i.ytimg.com/vi/' + d.video_id + '/maxresdefault.jpg', 'https://i.ytimg.com/vi/' + d.video_id + '/hqdefault.jpg'],
            source: 'youtube',
          };
          this.lastT = -1;
        }
        if (this.track && (t !== this.lastT || playing !== this.lastPlaying)) {
          this.app.onPlayback(this.track, t, playing, performance.now());
          this.lastT = t; this.lastPlaying = playing;
        }
      } catch (e) { /* player not ready yet */ }
    }
    this.timer = setTimeout(() => this.tick(), 100);
  }
  togglePlay() {
    if (!this.player || !this.ready) return;
    if (this.player.getPlayerState() === 1) this.player.pauseVideo(); else this.player.playVideo();
  }
  seek(d) {
    if (!this.player || !this.ready) return;
    this.player.seekTo(Math.max(0, (this.player.getCurrentTime() || 0) + d), true);
  }
}

/* ---------- Demo: a built-in song with original placeholder lyrics ---------- */
const DEMO_LRC = `[ti:夜行列車]
[ar:Lyrics Studio]
[00:00.00]
[00:03.00]窗外的燈一盞一盞往後退
[00:07.20]像把整座城市慢慢摺起來
[00:11.40]Every light I pass becomes a memory
[00:11.40]經過的每一盞燈 都變成回憶
[00:15.80]我在最後一節車廂等天亮
[00:20.00]你說過的話還在耳邊亮著
[00:24.20]像一台忘了關的收音機
[00:28.40]
[00:36.00]So I hum it low, I hum it slow
[00:40.20]讓旋律替我把話說完
[00:44.40]終點站到了也沒關係
[00:48.60]這一段路 我都記得
[00:53.80]`;

class DemoSource {
  constructor(app) { this.app = app; this.active = false; this.pos = 0; this.playing = true; this.track = null; this.timer = 0; this.last = 0; }
  makeTrack() {
    if (this.track) return this.track;
    const { c, ctx } = makeCanvas(640, 640);
    const g = ctx.createLinearGradient(0, 0, 640, 640);
    g.addColorStop(0, '#16224f'); g.addColorStop(0.55, '#5d3a9b'); g.addColorStop(1, '#f2a27a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 640, 640);
    const m = ctx.createRadialGradient(440, 190, 0, 440, 190, 130);
    m.addColorStop(0, 'rgba(255,248,232,1)'); m.addColorStop(0.5, 'rgba(255,236,204,0.85)'); m.addColorStop(1, 'rgba(255,236,204,0)');
    ctx.fillStyle = m; ctx.fillRect(0, 0, 640, 640);
    for (let i = 0; i < 10; i++) {
      ctx.fillStyle = `rgba(255,${196 + i * 5},${140 + i * 9},${0.12 + i * 0.05})`;
      ctx.fillRect(30 + i * 16, 430 + i * 13, 580 - i * 28, 3);
    }
    ctx.fillStyle = 'rgba(9,10,28,0.88)';
    ctx.beginPath(); ctx.moveTo(0, 560);
    for (let x = 0; x <= 640; x += 40) ctx.lineTo(x, 540 - ((x * 7919) % 70));
    ctx.lineTo(640, 640); ctx.lineTo(0, 640); ctx.closePath(); ctx.fill();
    this.track = { key: 'demo', title: '夜行列車', artist: 'Lyrics Studio 示範曲', album: '', duration: 60, artCanvas: c, lrc: DEMO_LRC, source: 'demo' };
    return this.track;
  }
  start() { this.active = true; this.makeTrack(); this.last = performance.now(); this.app.setStatus('示範模式'); this.tick(); }
  stop() { this.active = false; clearTimeout(this.timer); }
  tick() {
    if (!this.active) return;
    const now = performance.now();
    if (this.playing) this.pos += (now - this.last) / 1000;
    this.last = now;
    if (this.pos >= this.track.duration) this.pos = 0;
    this.app.onPlayback(this.track, this.pos, this.playing, now);
    this.timer = setTimeout(() => this.tick(), 250);
  }
  togglePlay() { this.playing = !this.playing; this.app.onPlayback(this.track, this.pos, this.playing, performance.now()); }
  seek(d) { this.jump(this.pos + d); }
  jump(t) { this.pos = clamp(t, 0, this.track.duration - 0.05); this.last = performance.now(); this.app.onPlayback(this.track, this.pos, this.playing, this.last); }
}
