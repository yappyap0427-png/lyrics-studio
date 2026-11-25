/* ---------- playback clock ----------
   `truth` follows the latest report exactly. What we show stays continuous: after each report the
   gap between what was on screen and the truth fades out over ~0.3 s, including play/pause flips.
   Only real seeks (or a new track) jump. */
class Clock {
  constructor() { this.pos = 0; this.at = performance.now(); this.playing = false; this.corr = 0; this.corrAt = 0; }
  truth(ts = performance.now()) { return this.pos + (this.playing ? (ts - this.at) / 1000 : 0); }
  correction(ts) {
    if (!this.corr) return 0;
    const k = Math.exp(-(ts - this.corrAt) / 110);
    if (k < 0.002) { this.corr = 0; return 0; }
    return this.corr * k;
  }
  now(ts = performance.now()) { return this.truth(ts) + this.correction(ts); }
  sync(pos, playing, ts = performance.now(), hard = false) {
    const shown = this.now(ts);
    this.pos = pos; this.at = ts; this.playing = playing;
    const gap = shown - pos;
    if (!hard && Math.abs(gap) < 1.5) { this.corr = gap; this.corrAt = ts; } else this.corr = 0;
  }
}

/* ---------- Spotify: Web API, Authorization Code + PKCE (no secret needed) ----------
   Only one tab polls Spotify (it holds a Web Lock); the others get its results over a
   BroadcastChannel. A hidden leader hands the job to a visible tab. */
const SP_LOCK = 'lyrics-studio-spotify-poll';
const SP_IDLE = {
  login: { title: '還沒連接 Spotify', hint: '點上方的 Spotify 完成設定', status: 'Spotify 未連接' },
  nothing: { title: 'Spotify 目前沒有在播放', hint: '在任何裝置上播一首歌，這裡就會跟著顯示', status: 'Spotify 待命' },
  ad: { title: '廣告播放中', hint: '廣告結束後會接回歌詞', status: 'Spotify 播廣告中' },
  episode: { title: '正在播放 Podcast', hint: 'Podcast 沒有同步歌詞', status: 'Spotify 播 Podcast 中' },
  denied: { title: 'Spotify 拒絕存取', hint: '開發模式需要 App 擁有者有 Premium', status: 'Spotify 拒絕存取' },
  env: { title: '這個網址不能登入 Spotify', hint: '改用線上版，或用 start.bat 開啟', status: 'Spotify 無法使用' },
};
class SpotifySource {
  constructor(app) {
    this.app = app; this.active = false; this.timer = 0; this.loop = 0; this.gen = 0;
    this.leader = false; this.unlock = null; this.ch = null; this.hb = 0; this.warned403 = false;
    this.canSeek = false; this.hasVolume = false;
  }
  get clientId() { return Store.get('spotify.clientId', ''); }
  get token() { return Store.get('spotify.token', null); }
  redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }
  originProblem() { return Env.can('spotify') ? null : Env.kind(); }
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
      const r = await fetchT('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, 10000);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast('Spotify 登入失敗：' + (j.error_description || j.error || r.status), 0); return true; }
      this.saveToken(j);
      Store.del('spotify.pkce');
      toast('已連接 Spotify');
    } catch (e) { toast('連不到 Spotify 登入伺服器，檢查網路後再試', 0); }
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
    const r = await fetchT('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, 10000);
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
  logout() { Store.del('spotify.token'); this.idle('login'); }

  /* ----- who polls ----- */
  start() {
    this.active = true; this.warned403 = false;
    const id = ++this.loop;
    if (!this.ch && typeof BroadcastChannel !== 'undefined') { try { this.ch = new BroadcastChannel('lyrics-studio-spotify'); } catch (e) { this.ch = null; } }
    if (this.ch) {
      this.ch.onmessage = ev => this.onPeer(ev.data, id);
      clearInterval(this.hb);
      this.hb = setInterval(() => this.sayVisible(), 3000);
    }
    this.app.setStatus('Spotify 連線中…');
    this.candidate(id);
    this.sayVisible();
  }
  stop() {
    this.active = false; this.loop++; this.gen++; this.leader = false;
    clearTimeout(this.timer); clearInterval(this.hb);
    if (this.unlock) { this.unlock(); this.unlock = null; }
    if (this.ch) this.ch.onmessage = null;
  }
  candidate(id) {
    if (!(navigator.locks && navigator.locks.request)) { this.lead(id); return; }
    navigator.locks.request(SP_LOCK, () => {
      if (!this.active || id !== this.loop) return undefined; // stopped while waiting: hand it straight back
      this.lead(id);
      return new Promise(res => { this.unlock = res; });
    }).catch(() => { if (this.active && id === this.loop && !this.leader) this.lead(id); });
  }
  lead(id) { this.leader = true; const gen = ++this.gen; this.poll(id, gen); }
  yieldLead() {
    if (!this.leader) return;
    this.leader = false; this.gen++; clearTimeout(this.timer);
    const u = this.unlock; this.unlock = null;
    if (u) u();
    this.candidate(this.loop); // queue up again behind the visible tab
  }
  onVisible() {
    if (!this.active) return;
    if (this.leader) { clearTimeout(this.timer); const gen = ++this.gen; this.poll(this.loop, gen); } // refresh right away
    else this.sayVisible();
  }
  sayVisible() { if (this.ch && this.active && !this.leader && !document.hidden) { try { this.ch.postMessage({ type: 'visible' }); } catch (e) { /* closed */ } } }
  post(m) { if (this.ch && this.leader) { try { this.ch.postMessage(m); } catch (e) { /* closed */ } } }
  onPeer(m, id) {
    if (!this.active || id !== this.loop || !m) return;
    if (m.type === 'visible') { if (this.leader && document.hidden) this.yieldLead(); return; }
    if (this.leader) return;
    if (m.type === 'playback') this.app.onPlayback(m.track, m.pos + (m.playing ? (Date.now() - m.wall) / 1000 : 0), m.playing);
    else if (m.type === 'idle') this.idle(m.kind, true);
    else if (m.type === 'status') this.app.setStatus(m.text);
  }
  idle(kind, fromPeer) {
    this.app.onIdle(Object.assign({ key: 'spotify-' + kind }, SP_IDLE[kind]));
    if (!fromPeer) this.post({ type: 'idle', kind });
  }
  status(text) { this.app.setStatus(text); this.post({ type: 'status', text }); }

  async poll(id, gen) {
    const live = () => this.active && id === this.loop && gen === this.gen && this.leader;
    if (!live()) return;
    let next = 1000;
    try {
      if (!this.token) { this.idle(Env.can('spotify') ? 'login' : 'env'); next = 3000; }
      else {
        let tok = await this.accessToken();
        const url = 'https://api.spotify.com/v1/me/player/currently-playing';
        const t0 = performance.now();
        let r = await fetchT(url, { headers: { Authorization: 'Bearer ' + tok } }, 8000);
        if (r.status === 401) { tok = await this.refresh(); r = await fetchT(url, { headers: { Authorization: 'Bearer ' + tok } }, 8000); }
        const t1 = performance.now();
        if (!live()) return;
        if (r.status === 204 || r.status === 202) { this.idle('nothing'); next = 2500; }
        else if (r.status === 429) {
          next = (parseFloat(r.headers.get('Retry-After')) || 5) * 1000 + 500;
          this.status('Spotify 請求太頻繁，稍等一下');
        } else if (r.status === 403) {
          const j = await r.json().catch(() => ({}));
          if (!this.warned403) {
            this.warned403 = true;
            toast('Spotify 拒絕存取：' + ((j.error && j.error.message) || '403') + '。開發模式需要 App 擁有者有 Premium；用別的帳號登入時，要先在 App 的 User Management 加入那個帳號。', 0);
          }
          this.idle('denied');
          next = 15000;
        } else if (r.ok) {
          const j = await r.json();
          if (!j || !j.item) {
            this.idle(j && j.currently_playing_type === 'ad' ? 'ad' : j && j.currently_playing_type === 'episode' ? 'episode' : 'nothing');
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
            this.post({ type: 'playback', track, pos, playing: !!j.is_playing, wall: Date.now() });
            next = j.is_playing ? 1000 : 2000;
          }
        } else { this.status('Spotify 回應錯誤 ' + r.status); next = 4000; }
      }
    } catch (e) {
      console.warn('[spotify]', e);
      if (e.message === 'NO_REFRESH' || e.message === 'REFRESH_FAILED') {
        if (!this.token) this.idle('login'); else this.status('Spotify 重新登入中…');
      } else this.status(e.code === 'TIMEOUT' ? 'Spotify 沒有回應，重試中…' : '連不到 Spotify，重試中…');
      next = 4000;
    }
    if (document.hidden) next = Math.max(next, 2000);
    if (live()) this.timer = setTimeout(() => this.poll(id, gen), next);
  }
}
function pickImage(imgs) {
  if (!imgs || !imgs.length) return null;
  return imgs.slice().sort((a, b) => Math.abs((a.width || 640) - 640) - Math.abs((b.width || 640) - 640))[0].url;
}

/* ---------- YouTube / YouTube Music: song plays in an embedded player ---------- */
function parseVideoTitle(title, author) {
  let t = String(title || '').trim();
  const channel = String(author || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s*(official|官方)(\s*(artist\s*)?(channel|頻道))?$/i, '').trim();
  let a = channel;
  const inst = KARAOKE_RE.test(t);
  const NOISE = /(official|music\s*video|lyric|lyrics|audio|visuali[sz]er|\bmv\b|m\/v|\bhd\b|\b4k\b|live|官方|完整版|歌詞|動態|高音質|中字|字幕)/i;
  t = t.replace(/[(\[【（〔][^)\]】）〕]*[)\]】）〕]/g, m => (NOISE.test(m) || KARAOKE_RE.test(m) ? '' : m)).replace(/\s{2,}/g, ' ').trim();
  t = stripKaraoke(t);
  let m = t.match(/^(.+?)\s+[-–—|]\s+(.+)$/);
  if (m) {
    a = stripKaraoke(m[1]); t = stripKaraoke(m[2]);
    // usually "Artist - Title"; when the channel name matches the right-hand side it was "Title - Artist"
    const tight = s => String(s || '').toLowerCase().normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
    const like = (x, y) => { x = tight(x); y = tight(y); return !!(x && y && (x === y || x.includes(y) || y.includes(x))); };
    if (channel && like(channel, t) && !like(channel, a)) [a, t] = [t, a];
  } else {
    m = t.match(/^(.+?)\s*[《『「【](.+?)[》』」】]/);
    if (m) { a = m[1].trim(); t = stripKaraoke(m[2]); }
  }
  t = t.replace(/\s+(official\s*)?(music\s*video|mv|m\/v)$/i, '').replace(/["“”]/g, '').trim();
  return { title: t, artist: a, inst };
}

class YouTubeSource {
  constructor(app) {
    this.app = app; this.player = null; this.ready = false; this.videoId = null; this.track = null;
    this.active = false; this.timer = 0; this.lastT = -1; this.lastPlaying = null; this.n = 0;
    this.canSeek = true; this.hasVolume = true;
  }
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
    if (!Env.can('youtube')) { toast('直接打開 HTML 檔時，YouTube 播放器不能用。請改用線上版，或用 start.bat 開啟。', 0); return false; }
    const id = YouTubeSource.parseId(input);
    if (!id) { toast('看不懂這個連結，請貼 YouTube 或 YouTube Music 的歌曲網址', 5000); return false; }
    this.videoId = id;
    Store.set('yt.last', String(input).trim());
    this.track = null;
    try { await this.loadApi(); } catch (e) { toast('載入不了 YouTube 播放器，檢查網路後再試', 0); return false; }
    this.app.showYtCard(true);
    if (this.player && this.ready) this.player.loadVideoById(id);
    else if (!this.player) {
      this.player = new YT.Player('ytplayer', {
        width: 356, height: 200, videoId: id,
        playerVars: { autoplay: 1, playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady: () => {
            this.ready = true;
            this.setVolume(Store.get('yt.vol', 100));
            try { this.player.playVideo(); } catch (e) { /* ignore */ }
          },
          onError: e => this.onErr(e),
        },
      });
    }
    return true;
  }
  onErr(e) {
    const c = e && e.data;
    if (c === 2) toast('這個影片網址不正確', 6000);
    else if (c === 5) toast('播放器出錯，換一首試試', 6000);
    else if (c === 100) toast('找不到這個影片，可能被刪除或設成私人', 0);
    else if (c === 101 || c === 150) toast('版權方不允許在其他網站播放這支影片。換一個版本試試，例如 YouTube Music 的歌曲連結。', 0);
    else if (c === 153) toast('播放器拿不到網址來源。請改用線上版，或用 start.bat 開啟程式。', 0);
    else toast('播放失敗（錯誤 ' + c + '）', 0);
  }
  start() {
    this.active = true;
    if (this.player) this.app.showYtCard(true);
    if (!this.videoId) this.app.onIdle({ key: 'youtube-empty', title: '貼上一首歌的連結', hint: '點上方的 YouTube 開始', status: 'YouTube 待命' });
    this.tick();
  }
  stop() {
    this.active = false;
    clearTimeout(this.timer);
    try { if (this.player && this.ready) this.player.pauseVideo(); } catch (e) { /* ignore */ }
    this.app.showYtCard(false);
  }
  /* the player's getters read state it already received, so polling them is cheap;
     title and length only change with the video, so read those once a second */
  tick() {
    if (!this.active) return;
    const p = this.player;
    if (p && this.ready && typeof p.getCurrentTime === 'function') {
      try {
        const st = p.getPlayerState();
        const t = p.getCurrentTime() || 0;
        const playing = st === 1;
        if (!this.track || this.n++ % 10 === 0) {
          const d = p.getVideoData ? p.getVideoData() : null;
          const dur = p.getDuration ? p.getDuration() : 0;
          if (d && d.video_id && d.title && dur > 0 && (!this.track || this.track.vid !== d.video_id)) {
            const meta = parseVideoTitle(d.title, d.author);
            this.track = {
              key: 'yt:' + d.video_id, vid: d.video_id,
              title: meta.title || d.title, artist: meta.artist || d.author || '', album: '',
              duration: dur, inst: meta.inst,
              art: ['https://i.ytimg.com/vi/' + d.video_id + '/maxresdefault.jpg', 'https://i.ytimg.com/vi/' + d.video_id + '/hqdefault.jpg'],
              source: 'youtube',
            };
            this.lastT = -1;
          }
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
  seekTo(t) {
    if (!this.player || !this.ready) return;
    const d = this.player.getDuration ? this.player.getDuration() : 0;
    this.player.seekTo(clamp(t, 0, d ? d - 0.5 : t), true);
  }
  seek(d) { if (this.player && this.ready) this.seekTo((this.player.getCurrentTime() || 0) + d); }
  setVolume(v) {
    v = clamp(Math.round(v), 0, 100);
    Store.set('yt.vol', v);
    try { if (this.player && this.ready && this.player.setVolume) { this.player.setVolume(v); if (v > 0 && this.player.unMute) this.player.unMute(); } } catch (e) { /* ignore */ }
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
  constructor(app) { this.app = app; this.active = false; this.pos = 0; this.playing = true; this.track = null; this.timer = 0; this.last = 0; this.canSeek = true; this.hasVolume = false; }
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
  seekTo(t) { this.jump(t); }
  jump(t) { this.pos = clamp(t, 0, this.track.duration - 0.05); this.last = performance.now(); this.app.onPlayback(this.track, this.pos, this.playing, this.last); }
}
