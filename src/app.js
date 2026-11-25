/* ---------- app: wires sources → clock → lyrics → renderer, plus all the UI ---------- */
const LIVE_URL = 'https://yappyap0427-png.github.io/lyrics-studio/';
const LAYOUTS = ['fit', '16:9', '9:16', '1:1'];
const LAYOUT_INFO = {
  fit: { label: '填滿', desc: '跟著視窗大小' },
  '16:9': { label: '16:9', desc: '1920 × 1080 橫向' },
  '9:16': { label: '9:16', desc: '1080 × 1920，TikTok、Reels、Shorts' },
  '1:1': { label: '1:1', desc: '1440 × 1440 方形' },
};
const LAYOUT_SIZE = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1440, 1440] };
const SOURCE_NAME = { spotify: 'Spotify', youtube: 'YouTube', demo: '示範' };

const App = {
  init() {
    this.S = Object.assign({
      source: 'demo', theme: 'flow', layout: 'fit', offset: 0,
      karaoke: true, blur: true, align: 'auto', scale: 1, showInfo: true, credit: true,
      recAudio: 'none', recFps: 60, recQuality: 'high', recAutoStop: true, recCountdown: true, recFormat: 'auto',
    }, Store.get('settings', {}));
    if (!LAYOUTS.includes(this.S.layout)) this.S.layout = 'fit';
    if (!THEMES[this.S.theme]) this.S.theme = 'flow';
    this.canvas = $('#stage');
    this.clock = new Clock();
    this.track = null; this.idleKey = null; this.lyrTok = 0; this.lyrCtl = null; this.statusText = '';
    this.r = new Renderer(this.canvas);
    this.r.onPalette = p => this.applyPalette(p);
    this.r.onPerfLow = () => toast('畫面有點吃力，已自動關閉遠處模糊', 5000);
    this.r.setTheme(this.S.theme);
    this.r.setOpts(this.viewOpts());
    this.rec = new Recorder(this.canvas);
    this.rec.onstate = (st, blob, type, reason) => this.onRecState(st, blob, type, reason);
    this.rec.onwarn = code => this.onRecWarn(code);
    this.sources = { spotify: new SpotifySource(this), youtube: new YouTubeSource(this), demo: new DemoSource(this) };
    this.bindUI();
    this.resize();
    addEventListener('resize', () => this.resize());
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', () => this.r.fontsChanged());
    this.checkEnv();

    const q = new URLSearchParams(location.search);
    if (q.has('code') || q.has('error')) this.sources.spotify.handleRedirect().finally(() => this.setSource('spotify'));
    else this.setSource(this.S.source);

    this.updateDock();
    this.last = performance.now();
    requestAnimationFrame(() => this.frame());
  },
  viewOpts() { const S = this.S; return { karaoke: S.karaoke, blur: S.blur, align: S.align, scale: S.scale, showInfo: S.showInfo, credit: S.credit }; },
  save() { Store.set('settings', this.S); },

  /* ---------- drawing loop ---------- */
  hidden() { return document.hidden || !!this.simHidden; },
  frame() {
    if (!this.hidden()) this.step();
    requestAnimationFrame(() => this.frame());
  },
  step() {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const songT = this.track ? this.clock.now(now) : 0;
    this.r.draw(songT, songT - this.S.offset, dt, this.clock.playing);
    if (this.rec.active) {
      const s = fmtTime(this.rec.elapsed());
      if (this.recShown !== s) { this.recShown = s; $('#recTime').textContent = s; if (this.rec.streaming) $('#recBytes').textContent = (this.rec.bytes / 1048576).toFixed(1) + ' MB'; }
    }
    this.updateScrub(songT);
    const line = this.r.curLine || '';
    if (line !== this.srLine) { this.srLine = line; $('#srLyric').textContent = line; }
  },
  /* a hidden tab gets no animation frames; while recording, a worker keeps time so the video never freezes.
     The worker waits for each frame to finish before sending the next tick, so a slow machine never builds a backlog. */
  startTicker(fps) {
    if (this.ticker) return;
    try {
      const src = 'let id=0,busy=false;onmessage=e=>{if(e.data==="done"){busy=false;return}clearInterval(id);busy=false;' +
        'if(e.data>0)id=setInterval(()=>{if(!busy){busy=true;postMessage(0)}},1000/e.data)}';
      this.tickerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const w = (this.ticker = new Worker(this.tickerUrl));
      w.onmessage = () => {
        try { if (this.hidden()) this.step(); } finally { if (this.ticker === w) w.postMessage('done'); }
      };
      w.postMessage(fps);
    } catch (e) { this.ticker = null; }
  },
  stopTicker() {
    if (!this.ticker) return;
    this.ticker.terminate(); this.ticker = null;
    URL.revokeObjectURL(this.tickerUrl);
  },

  /* ---------- playback events from the sources ---------- */
  onPlayback(track, pos, playing, ts = performance.now()) {
    this.idleKey = null;
    if (!this.track || this.track.key !== track.key) {
      if (this.rec.active && this.S.recAutoStop && this.track) { this.rec.stop('ended'); toast('換歌了，已停止錄影'); }
      this.track = track;
      this.clock.sync(pos, playing, ts, true);
      this.r.setTrack(track);
      this.canvas.setAttribute('aria-label', '歌詞畫面：' + track.title + (track.artist ? '，' + track.artist : ''));
      this.loadLyrics(track);
    } else {
      const pred = this.clock.now(ts);
      if (this.rec.active && this.S.recAutoStop && pos + 2 < pred && pred > (track.duration || 0) - 4) { this.rec.stop('ended'); toast('歌曲播完，已停止錄影'); }
      this.clock.sync(pos, playing, ts);
      if (track.duration && !this.track.duration) this.track.duration = track.duration;
    }
    this.setStatus(this.S.source === 'demo' ? '示範模式' : `${SOURCE_NAME[this.S.source]} ${playing ? '播放中' : '已暫停'}`);
  },
  /* sources describe their own idle state: { key, title, hint, status } */
  onIdle(info) {
    if (this.idleKey === info.key && !this.track) return;
    this.idleKey = info.key;
    if (this.track) { this.track = null; this.r.setTrack(null); this.canvas.setAttribute('aria-label', '歌詞畫面'); }
    this.lyrTok++;
    if (this.lyrCtl) { this.lyrCtl.abort(); this.lyrCtl = null; }
    this.r.setLyrics({ status: 'idle', note: info.title, hint: info.hint || '' });
    if (info.status) this.setStatus(info.status);
  },
  setStatus(text) { if (text !== this.statusText) { this.statusText = text; $('#status').textContent = text; } },
  seekTo(t) { if (this.src && this.src.canSeek && this.src.seekTo) this.src.seekTo(t); },

  /* ---------- lyrics ---------- */
  async loadLyrics(track, opts = {}) {
    const tok = ++this.lyrTok;
    if (this.lyrCtl) { this.lyrCtl.abort(); this.lyrCtl = null; } // the previous song's lookup is no longer wanted
    const imported = Store.get('lrcImport.' + track.key, null); // the user's own file wins, even over the demo song's built-in lyrics
    if (imported) { this.applyLrc(imported, track); return; }
    if (track.lrc) { this.applyLrc(track.lrc, track); return; }
    const ctl = (this.lyrCtl = new AbortController());
    this.r.setLyrics({ status: 'loading' });
    try {
      const rec = await Lyrics.find(track, Object.assign({ signal: ctl.signal }, opts));
      if (tok !== this.lyrTok) return;
      this.applyRecord(rec, track);
    } catch (e) {
      if (tok !== this.lyrTok || e.name === 'AbortError') return;
      console.warn('[lyrics]', e);
      const note = e.message === 'RATE_LIMIT' ? '歌詞資料庫請求太頻繁，等幾秒再按 L 重試'
        : e.code === 'TIMEOUT' ? `歌詞資料庫超過 ${Math.round(Lyrics.timeoutMs / 1000)} 秒沒有回應，按 L 重試`
        : '連不到歌詞資料庫 lrclib.net，檢查網路後按 L 重試';
      this.r.setLyrics({ status: 'error', note });
    } finally { if (this.lyrCtl === ctl) this.lyrCtl = null; }
  },
  applyRecord(rec, track) {
    if (rec && rec.none) { this.r.setLyrics({ status: 'off' }); return; }
    if (!rec) { this.r.setLyrics({ status: 'notfound' }); return; }
    if (rec.syncedLyrics) { this.applyLrc(rec.syncedLyrics, track); return; }
    if (rec.instrumental) { this.r.setLyrics({ status: 'instrumental' }); return; }
    if (rec.plainLyrics) { this.r.setLyrics({ status: 'plain', plain: rec.plainLyrics.replace(/\r/g, '').split('\n') }); return; }
    this.r.setLyrics({ status: 'notfound' });
  },
  applyLrc(text, track) {
    const entries = LRC.buildTimeline(LRC.parse(text), track && track.duration);
    if (entries.length) { this.r.setLyrics({ status: 'synced', entries }); return; }
    const plain = String(text).replace(/\r/g, '').split('\n').filter(l => !/^\s*\[[a-z#]+:.*\]\s*$/i.test(l));
    this.r.setLyrics(plain.some(l => l.trim()) ? { status: 'plain', plain } : { status: 'notfound' });
  },
  stopLyricsLookup() { this.lyrTok++; if (this.lyrCtl) { this.lyrCtl.abort(); this.lyrCtl = null; } },
  async importFile(file) {
    const t = this.track;
    if (!t) { toast('先播放一首歌，再匯入歌詞', 5000); return; }
    if (file.size > 1024 * 1024) { toast(`「${file.name}」太大了。LRC 歌詞檔通常只有幾 KB，確認選對檔案了嗎？`, 0); return; }
    let text;
    try { text = decodeText(await file.arrayBuffer()); } catch (e) { toast('讀不到這個檔案', 6000); return; }
    const info = LRC.inspect(text);
    if (info.kind === 'binary') { toast(`「${file.name}」不是文字檔，沒辦法當歌詞匯入`, 0); return; }
    if (info.kind === 'empty') { toast(`「${file.name}」裡面沒有歌詞`, 0); return; }
    Store.set('lrcImport.' + t.key, text);
    Store.del('lyricsPick.' + t.key);
    this.stopLyricsLookup();
    this.applyLrc(text, t);
    if (info.kind === 'synced') toast(`已匯入 ${file.name}（${info.lines} 行同步歌詞）`, 4000);
    else toast(`已匯入 ${file.name}。這個檔案沒有時間標記，會當成未同步歌詞，跟著進度慢慢捲動。`, 8000);
  },
  resetLyrics() {
    const t = this.track;
    if (!t) return;
    Store.del('lrcImport.' + t.key); Store.del('lyricsPick.' + t.key);
    Lyrics.clearCache(t.key);
    this.loadLyrics(t, { force: true });
    toast('改回自動配對');
  },
  pinNone() {
    const t = this.track;
    if (!t) return;
    Store.set('lyricsPick.' + t.key, 'none'); Store.del('lrcImport.' + t.key);
    Lyrics.clearCache(t.key);
    this.stopLyricsLookup();
    this.r.setLyrics({ status: 'off' });
    $('#dlgSearch').close();
    toast('這首歌之後不顯示歌詞。按 L 可以改回來。', 5000);
  },

  /* ---------- sources ---------- */
  setSource(name) {
    if (!this.sources[name]) name = 'demo';
    if (this.src) this.src.stop();
    this.S.source = name; this.save();
    this.track = null; this.idleKey = null;
    this.stopLyricsLookup();
    this.r.setTrack(null);
    this.r.setLyrics({ status: 'idle', note: '等待播放' });
    this.clock.sync(0, false, performance.now(), true);
    $$('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.src === name)));
    this.scrubShown = null;
    this.src = this.sources[name];
    this.src.start();
    if (name === 'spotify' && !this.sources.spotify.token) this.openSpotify();
    if (name === 'youtube' && !this.sources.youtube.videoId) this.openYoutube();
  },
  showYtCard(on) { $('#ytcard').hidden = !on; },
  checkEnv() {
    const k = Env.kind();
    const msg = {
      file: '直接點兩下 HTML 檔打開時，Spotify 和 YouTube 不能用（示範曲和錄影可以）。請改用線上版，或在資料夾裡點兩下 start.bat。',
      localhost: 'Spotify 不接受 localhost 網址。把網址裡的 localhost 換成 127.0.0.1 就能登入。',
      http: '這個網址不是 https，Spotify 登入和錄影可能不能用。',
    }[k];
    if (!msg) return;
    $('#envMsg').textContent = msg;
    const a = $('#envLink');
    if (k === 'localhost') { a.href = location.href.replace('//localhost', '//127.0.0.1'); a.textContent = '改用 127.0.0.1 開啟'; }
    else { a.href = LIVE_URL; a.textContent = '開啟線上版'; }
    $('#envBar').hidden = false;
  },

  /* ---------- dialogs ---------- */
  openSpotify() {
    const sp = this.sources.spotify, prob = sp.originProblem(), w = $('#spWarn');
    $('#spRedirect').textContent = sp.redirectUri();
    $('#spClient').value = sp.clientId || '';
    $('#spLogout').hidden = !sp.token;
    w.hidden = !prob;
    w.textContent = prob === 'file' ? '直接打開 HTML 檔無法登入 Spotify。請改用線上版，或用 start.bat 開啟。'
      : prob === 'localhost' ? 'Spotify 不接受 localhost。請改用 http://127.0.0.1 開頭的網址開啟這個頁面。'
      : prob ? 'Spotify 只接受 https 或 127.0.0.1 網址。請改用線上版，或用 start.bat 開啟。' : '';
    $('#dlgSpotify').showModal();
  },
  openYoutube() { $('#ytUrl').value = Store.get('yt.last', ''); $('#dlgYoutube').showModal(); setTimeout(() => $('#ytUrl').select(), 30); },
  openSearch() {
    const t = this.track;
    $('#q').value = t ? [Lyrics.cleanTitle(t.title), String(t.artist || '').split(',')[0]].join(' ').trim() : '';
    $('#results').replaceChildren();
    this.hidePreview();
    $('#btnAuto').hidden = !t; $('#btnNone').hidden = !t;
    $('#dlgSearch').showModal();
    if ($('#q').value) this.doSearch();
  },
  msgItem(text) { const li = document.createElement('li'); li.className = 'msg'; li.textContent = text; return li; },
  async doSearch() {
    const q = $('#q').value.trim(), ul = $('#results');
    if (!q) return;
    this.hidePreview();
    if (this.searchCtl) this.searchCtl.abort();
    const ctl = (this.searchCtl = new AbortController());
    ul.replaceChildren(this.msgItem('搜尋中…'));
    try {
      const list = await Lyrics.search({ q }, ctl.signal);
      if (ctl !== this.searchCtl) return;
      if (!list.length) { ul.replaceChildren(this.msgItem('沒有結果。換個寫法試試，例如只打歌名。')); return; }
      const t = this.track;
      list.sort((a, b) => (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0) || (t && t.duration ? Math.abs(a.duration - t.duration) - Math.abs(b.duration - t.duration) : 0));
      ul.replaceChildren();
      for (const r of list) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'res';
        const main = document.createElement('span'); main.className = 'r-main';
        const ti = document.createElement('span'); ti.className = 'r-title'; ti.textContent = r.trackName || r.name || '';
        const su = document.createElement('span'); su.className = 'r-sub'; su.textContent = r.artistName || '';
        if (r.albumName) { const al = document.createElement('span'); al.className = 'alb'; al.textContent = r.albumName; su.appendChild(al); }
        main.append(ti, su);
        const du = document.createElement('span'); du.className = 'r-dur'; du.textContent = fmtTime(r.duration);
        if (t && t.duration && Math.abs(r.duration - t.duration) > 3) { du.classList.add('off'); du.title = '長度和正在播放的歌不一樣，時間可能對不上'; }
        const bd = document.createElement('span'); bd.className = 'badge';
        bd.textContent = r.syncedLyrics ? '同步' : r.instrumental ? '純音樂' : '純文字';
        if (r.syncedLyrics) bd.classList.add('on');
        b.append(main, du, bd);
        b.onclick = () => this.showPreview(r);
        li.appendChild(b); ul.appendChild(li);
      }
    } catch (e) {
      if (ctl !== this.searchCtl || e.name === 'AbortError') return;
      ul.replaceChildren(this.msgItem(e.message === 'RATE_LIMIT' ? '請求太頻繁，等幾秒再試'
        : e.code === 'TIMEOUT' ? 'lrclib.net 沒有回應，等一下再試' : '連不到 lrclib.net，檢查網路後再試'));
    }
  },
  /* look before replacing: the first lines of a result, then apply or go back */
  showPreview(r) {
    this.pvRecord = r;
    $('#pvTitle').textContent = r.trackName || r.name || '';
    $('#pvMeta').textContent = [r.artistName, r.albumName, r.duration ? fmtTime(r.duration) : ''].filter(Boolean).join('，');
    $('#pvKind').textContent = r.syncedLyrics ? '同步歌詞' : r.instrumental ? '純音樂' : '未同步歌詞';
    const lines = r.syncedLyrics ? LRC.parse(r.syncedLyrics).lines.map(l => l.text).filter(Boolean)
      : String(r.plainLyrics || '').split('\n').map(s => s.trim()).filter(Boolean);
    const ul = $('#pvLines');
    ul.replaceChildren();
    if (!lines.length) ul.appendChild(this.msgItem(r.instrumental ? '純音樂，沒有歌詞' : '這份沒有歌詞內容'));
    for (const l of lines.slice(0, 8)) { const li = document.createElement('li'); li.textContent = l; ul.appendChild(li); }
    $('#searchList').hidden = true;
    $('#preview').hidden = false;
    $('#pvApply').focus();
  },
  hidePreview() { $('#preview').hidden = true; $('#searchList').hidden = false; this.pvRecord = null; },
  applyPreview() {
    const r = this.pvRecord, cur = this.track;
    if (!r) return;
    if (!cur) { toast('先播放一首歌，再套用歌詞', 5000); return; }
    Store.set('lyricsPick.' + cur.key, r.id); Store.del('lrcImport.' + cur.key);
    Lyrics.remember(cur.key, r);
    this.stopLyricsLookup();
    this.applyRecord(r, cur);
    $('#dlgSearch').close();
    toast('已套用這份歌詞');
  },

  /* ---------- recording ---------- */
  openRec() {
    if (this.rec.active) { this.rec.stop(); return; }
    if (this.rec.busy) { this.cancelCountdown(); return; }
    const f = $('#recForm');
    f.aud.value = this.S.recAudio;
    $('#recFps').value = String(this.S.recFps);
    $('#recQ').value = this.S.recQuality;
    $('#recFmt').value = this.S.recFormat;
    $('#recAuto').checked = !!this.S.recAutoStop;
    $('#recCd').checked = !!this.S.recCountdown;
    $('#recSize').textContent = `${this.canvas.width} × ${this.canvas.height}`;
    this.updateRecHint();
    $('#dlgRec').showModal();
  },
  updateRecHint() {
    const aud = $('#recForm').aud.value, src = this.S.source;
    const lines = [];
    if (aud === 'system' || aud === 'both') {
      if (src === 'spotify') lines.push('按開始後會跳出分享視窗：選「整個螢幕」，並打開「同時分享系統音訊」。');
      else if (src === 'demo') lines.push('示範曲本身沒有聲音，錄出來會是靜音。');
      else lines.push('按開始後會跳出分享視窗：選「這個分頁」，並打開「同時分享分頁音訊」。');
    }
    if (aud === 'mic' || aud === 'both') lines.push('戴耳機錄，麥克風才不會收到喇叭的聲音。');
    if (aud === 'none') lines.push('只錄畫面，之後可以在剪輯軟體配上音樂。');
    if (this.S.layout !== '9:16') lines.push('要發 TikTok 或 Reels，先把比例切到 9:16。');
    lines.push('切到其他分頁也會繼續錄，不過留在這個分頁畫面最順。');
    $('#recHint').textContent = lines.join(' ');
  },
  startRec(ev) {
    ev.preventDefault();
    const f = $('#recForm');
    Object.assign(this.S, {
      recAudio: f.aud.value, recFps: parseInt($('#recFps').value, 10) || 60, recQuality: $('#recQ').value,
      recFormat: $('#recFmt').value, recAutoStop: $('#recAuto').checked, recCountdown: $('#recCd').checked,
    });
    this.save();
    $('#dlgRec').close();
    this.rec.prepare({
      audio: this.S.recAudio, fps: this.S.recFps, bitrate: this.S.recQuality === 'high' ? 16e6 : 8e6,
      preferTab: this.S.source !== 'spotify', format: this.S.recFormat,
    })
      .then(() => this.countdown(this.S.recCountdown ? 3 : 0))
      .then(go => { if (go) this.rec.begin(); else { this.rec.cancel(); toast('已取消錄影'); } })
      .catch(err => this.recError(err));
  },
  recError(err) {
    const code = (err && (err.code || err.name)) || '';
    if (code === 'NO_SHARED_AUDIO') {
      toast(this.S.source === 'spotify'
        ? '沒有收到聲音。再錄一次，分享視窗選「整個螢幕」並打開「同時分享系統音訊」。分享視窗沒有這個選項的話（例如 Mac），改在分頁裡播 Spotify 網頁版，分享那個分頁並打開「同時分享分頁音訊」。'
        : '沒有收到聲音。再錄一次，分享視窗選「這個分頁」，並打開「同時分享分頁音訊」。', 0);
    } else if (code === 'NotAllowedError') toast('分享或麥克風權限被取消了，沒有開始錄影', 6000);
    else if (code === 'NotFoundError') toast('找不到麥克風，請確認已經接上', 0);
    else if (code === 'UNSUPPORTED') toast('這個瀏覽器不能錄影，請用最新版 Chrome 或 Edge', 0);
    else if (code !== 'BUSY') toast('無法開始錄影：' + ((err && err.message) || code), 0);
  },
  countdown(n) {
    if (!n) return Promise.resolve(true);
    const el = $('#countdown'), num = $('#cdNum');
    const pop = v => { num.textContent = v; num.classList.remove('pop'); void num.offsetWidth; num.classList.add('pop'); };
    return new Promise(res => {
      let left = n;
      const iv = setInterval(() => { left--; if (left <= 0) done(true); else pop(left); }, 1000);
      const done = ok => { clearInterval(iv); el.hidden = true; this.cdCancel = null; res(ok); };
      this.cdCancel = () => done(false);
      el.hidden = false; pop(left);
      $('#cdCancel').focus();
    });
  },
  cancelCountdown() { if (this.cdCancel) this.cdCancel(); },
  onRecState(st, blob, type, reason) {
    const on = st === 'recording' || st === 'paused';
    document.body.classList.toggle('recording', on);
    document.body.classList.toggle('rec-paused', st === 'paused');
    $('#recbar').hidden = !on;
    $('#btnRec .lbl').textContent = on ? '停止' : '錄影';
    $('#btnLayout').disabled = on;
    $('#recPause').textContent = st === 'paused' ? '繼續' : '暫停';
    $('#recBytes').hidden = !this.rec.streaming; // MP4 is only handed over at the end, so there is no running size to show
    this.recShown = '';
    if (on) { this.startTicker(this.S.recFps || 30); return; }
    this.stopTicker();
    this.resize();
    if (!blob) return;
    if (blob.size < 2000) { toast('錄到的檔案是空的', 0); return; }
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const name = `${safeName(this.track ? this.track.title : 'lyrics')}-${stamp()}.${ext}`;
    downloadBlob(blob, name);
    toast((reason === 'limit' ? '到了容量上限，已自動停止。' : '') + `已存成 ${name}（${(blob.size / 1048576).toFixed(1)} MB）`, 7000);
  },
  onRecWarn(code) {
    if (code === 'EMPTY') {
      if (this.S.recFormat !== 'webm') {
        this.S.recFormat = 'webm'; this.save();
        toast('剛開始錄的影片是空的，這台電腦的 MP4 編碼可能有問題。已改用 WebM 格式，請再按一次錄影。', 0);
      } else toast('剛開始錄的影片是空的。把流暢度改成 30 fps、畫質改成標準，再錄一次試試。', 0);
    } else if (code === 'NEAR_LIMIT') {
      const left = Math.max(1, Math.round((this.rec.maxBytes - this.rec.size()) / Math.max(1, this.rec.bps / 8) / 60));
      toast(this.rec.streaming
        ? `錄影檔快到 ${(this.rec.maxBytes / 1073741824).toFixed(1)} GB 上限，到了會自動停止並存檔。`
        : `MP4 錄影在存檔前都放在記憶體裡，大約再 ${left} 分鐘會到上限，到時會自動停止並存檔。要錄更久，請改用 WebM 格式。`, 0);
    }
  },

  /* ---------- view controls ---------- */
  nudge(d) {
    this.S.offset = Math.round((this.S.offset + d) * 10) / 10;
    if (Math.abs(this.S.offset) < 0.05) this.S.offset = 0;
    this.save(); this.updateDock();
  },
  setTheme(id) { this.S.theme = id; this.save(); this.r.setTheme(id); this.updateDock(); },
  setLayout(id) {
    if (this.rec.busy) { toast('錄影中不能換比例'); return false; }
    this.S.layout = id; this.save(); this.resize(); this.updateDock();
    return true;
  },
  cycleTheme() {
    const id = THEME_ORDER[(THEME_ORDER.indexOf(this.S.theme) + 1) % THEME_ORDER.length];
    this.setTheme(id);
    toast('風格：' + THEMES[id].label, 1600);
  },
  cycleLayout() {
    const id = LAYOUTS[(LAYOUTS.indexOf(this.S.layout) + 1) % LAYOUTS.length];
    if (this.setLayout(id)) toast('畫面比例：' + LAYOUT_INFO[id].label + '（' + LAYOUT_INFO[id].desc + '）', 2000);
  },
  updateDock() {
    const o = this.S.offset;
    $('#offVal').textContent = (o > 0 ? '+' : '') + o.toFixed(1) + 's';
    $('#btnTheme').textContent = THEMES[this.S.theme].label;
    $('#btnLayout').textContent = LAYOUT_INFO[this.S.layout].label;
  },
  /* style and size menus; hovering a style previews it on the canvas */
  openMenu(kind, anchor) {
    const was = this.menu && this.menu.kind;
    this.closeMenu();
    if (was === kind) return;
    const isTheme = kind === 'theme';
    const items = isTheme ? THEME_ORDER.map(id => ({ id, label: THEMES[id].label, desc: THEMES[id].desc }))
      : LAYOUTS.map(id => ({ id, label: LAYOUT_INFO[id].label, desc: LAYOUT_INFO[id].desc }));
    const cur = isTheme ? this.S.theme : this.S.layout;
    const m = document.createElement('div');
    m.className = 'menu glass'; m.setAttribute('role', 'menu'); m.setAttribute('aria-label', isTheme ? '風格' : '畫面比例');
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', String(it.id === cur)); b.dataset.id = it.id;
      if (!isTheme) { const box = document.createElement('span'); box.className = 'ratio r-' + it.id.replace(':', 'x'); b.appendChild(box); }
      const tx = document.createElement('span'); tx.className = 'mi';
      const l = document.createElement('span'); l.className = 'ml'; l.textContent = it.label;
      const d = document.createElement('span'); d.className = 'md'; d.textContent = it.desc;
      tx.append(l, d); b.appendChild(tx);
      b.onclick = () => { this.closeMenu(true); if (isTheme) this.setTheme(it.id); else this.setLayout(it.id); };
      if (isTheme) { b.addEventListener('pointerenter', () => this.r.setTheme(it.id)); b.addEventListener('focus', () => this.r.setTheme(it.id)); }
      m.appendChild(b);
    }
    $('.ui').appendChild(m);
    const ar = anchor.getBoundingClientRect();
    m.style.left = clamp(ar.left + ar.width / 2 - m.offsetWidth / 2, 8, innerWidth - m.offsetWidth - 8) + 'px';
    m.style.bottom = Math.round(innerHeight - ar.top + 12) + 'px';
    anchor.setAttribute('aria-expanded', 'true');
    this.menu = { el: m, kind, anchor };
    m.addEventListener('keydown', ev => {
      const bs = $$('button', m), i = bs.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') { ev.preventDefault(); bs[(i + 1) % bs.length].focus(); }
      else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') { ev.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
      else if (ev.key === 'Home') { ev.preventDefault(); bs[0].focus(); }
      else if (ev.key === 'End') { ev.preventDefault(); bs[bs.length - 1].focus(); }
      else if (ev.key === 'Escape' || ev.key === 'Tab') { ev.preventDefault(); this.closeMenu(true); }
      else return;
      ev.stopPropagation(); // handled here; the global shortcut handler must not see it
    });
    this.menuOutside = e => { if (!m.contains(e.target) && !anchor.contains(e.target)) this.closeMenu(); };
    setTimeout(() => document.addEventListener('pointerdown', this.menuOutside), 0);
    (m.querySelector('[aria-checked="true"]') || m.firstChild).focus();
  },
  closeMenu(refocus) {
    const mm = this.menu;
    if (!mm) return;
    this.menu = null;
    mm.el.remove();
    document.removeEventListener('pointerdown', this.menuOutside);
    mm.anchor.setAttribute('aria-expanded', 'false');
    if (mm.kind === 'theme') this.r.setTheme(this.S.theme); // drop the hover preview
    if (refocus) mm.anchor.focus();
  },
  toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => toast('這個瀏覽器不允許全螢幕'));
  },
  resize() {
    const c = this.canvas;
    let W, H;
    if (this.rec && this.rec.busy) { W = c.width; H = c.height; } // never change size mid-recording
    else if (LAYOUT_SIZE[this.S.layout]) [W, H] = LAYOUT_SIZE[this.S.layout];
    else {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = Math.round(innerWidth * dpr); H = Math.round(innerHeight * dpr);
      const k = Math.min(1, 2560 / Math.max(W, H));
      W = Math.round(W * k); H = Math.round(H * k);
    }
    W -= W % 2; H -= H % 2;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; this.r.resize(W, H); }
    const s = Math.min(innerWidth / W, innerHeight / H); // same factor on both axes: never stretched
    c.style.width = Math.round(W * s) + 'px';
    c.style.height = Math.round(H * s) + 'px';
  },
  applyPalette(p) {
    const st = document.documentElement.style;
    st.setProperty('--accent', p.accent.map(v => v | 0).join(' '));
    st.setProperty('--tint', p.dark.map(v => v | 0).join(' '));
  },
  updateScrub(songT) {
    const src = this.src, t = this.track;
    const show = !!(src && src.canSeek && t && t.duration > 0);
    if (show !== this.scrubShown) {
      this.scrubShown = show;
      $('#scrub').hidden = !show;
      $('#volWrap').hidden = !(src && src.hasVolume);
      if (src && src.hasVolume) $('#vol').value = String(Store.get('yt.vol', 100));
    }
    if (!show || this.scrubbing) return;
    const v = String(Math.round(clamp(songT / t.duration, 0, 1) * 1000));
    if (v !== this.scrubV) { this.scrubV = v; $('#seek').value = v; }
    const a = fmtTime(songT), b = fmtTime(t.duration);
    if (a !== this.tCurS || b !== this.tDurS) $('#seek').setAttribute('aria-valuetext', a + ' / ' + b);
    if (a !== this.tCurS) { this.tCurS = a; $('#tCur').textContent = a; }
    if (b !== this.tDurS) { this.tDurS = b; $('#tDur').textContent = b; }
  },

  /* ---------- wiring ---------- */
  bindUI() {
    $$('.seg button').forEach(b => b.addEventListener('click', () => {
      const s = b.dataset.src;
      if (s === this.S.source) { if (s === 'spotify') this.openSpotify(); else if (s === 'youtube') this.openYoutube(); }
      else this.setSource(s);
    }));
    $('#btnSearch').onclick = () => this.openSearch();
    $('#offMinus').onclick = () => this.nudge(-0.1);
    $('#offPlus').onclick = () => this.nudge(0.1);
    $('#btnTheme').onclick = ev => this.openMenu('theme', ev.currentTarget);
    $('#btnLayout').onclick = ev => this.openMenu('layout', ev.currentTarget);
    $('#btnFull').onclick = () => this.toggleFull();
    $('#btnRec').onclick = () => this.openRec();
    $('#recStop').onclick = () => this.rec.stop();
    $('#recPause').onclick = () => (this.rec.state === 'paused' ? this.rec.resume() : this.rec.pause());
    $('#cdCancel').onclick = () => this.cancelCountdown();
    $('#btnSettings').onclick = () => this.openSettings();
    $('#toast .x').onclick = () => hideToast();
    $('#envClose').onclick = () => { $('#envBar').hidden = true; };

    $('#spCopy').onclick = () => {
      const v = $('#spRedirect').textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(() => toast('已複製 Redirect URI'), () => toast('複製失敗，請手動選取'));
    };
    $('#spConnect').onclick = () => {
      const id = $('#spClient').value.trim();
      if (!/^[0-9a-f]{32}$/i.test(id)) { toast('Client ID 應該是 32 個英文和數字'); $('#spClient').focus(); return; }
      if (this.sources.spotify.originProblem()) { toast('目前的網址不能登入 Spotify，請照上面的提示換一個開啟方式', 0); return; }
      this.sources.spotify.login(id);
    };
    $('#spLogout').onclick = () => { this.sources.spotify.logout(); $('#dlgSpotify').close(); toast('已中斷 Spotify 連線'); };
    $('#ytForm').addEventListener('submit', ev => {
      ev.preventDefault();
      const v = $('#ytUrl').value.trim();
      if (!YouTubeSource.parseId(v)) { toast('看不懂這個連結，請貼 YouTube 或 YouTube Music 的歌曲網址', 5000); return; }
      $('#dlgYoutube').close();
      if (this.S.source !== 'youtube') this.setSource('youtube');
      this.sources.youtube.play(v);
    });
    $('#searchForm').addEventListener('submit', ev => { ev.preventDefault(); this.doSearch(); });
    $('#searchClose').onclick = () => $('#dlgSearch').close();
    $('#btnImport').onclick = () => $('#lrcFile').click();
    $('#btnAuto').onclick = () => { $('#dlgSearch').close(); this.resetLyrics(); };
    $('#btnNone').onclick = () => this.pinNone();
    $('#pvApply').onclick = () => this.applyPreview();
    $('#pvBack').onclick = () => { this.hidePreview(); const b = $('#results .res'); if (b) b.focus(); };
    $('#lrcFile').addEventListener('change', async ev => {
      const f = ev.target.files && ev.target.files[0];
      if (f) { $('#dlgSearch').close(); await this.importFile(f); }
      ev.target.value = '';
    });
    $('#recForm').addEventListener('submit', ev => this.startRec(ev));
    $('#recForm').addEventListener('change', () => this.updateRecHint());
    $('#recCancel').onclick = () => $('#dlgRec').close();
    $$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));

    // settings
    const bindCheck = (id, key) => $(id).addEventListener('change', ev => {
      this.S[key] = ev.target.checked; this.save(); this.r.setOpts({ [key]: this.S[key] });
      if (key === 'blur' && this.S.blur) this.r.perfLow = false;
    });
    bindCheck('#setKaraoke', 'karaoke'); bindCheck('#setBlur', 'blur'); bindCheck('#setInfo', 'showInfo'); bindCheck('#setCredit', 'credit');
    $('#setAlign').addEventListener('change', ev => { this.S.align = ev.target.value; this.save(); this.r.setOpts({ align: this.S.align }); });
    $('#setScale').addEventListener('input', ev => { this.S.scale = parseFloat(ev.target.value) || 1; this.save(); this.r.setOpts({ scale: this.S.scale }); $('#scaleVal').textContent = Math.round(this.S.scale * 100) + '%'; });
    $('#setOffReset').onclick = () => { this.S.offset = 0; this.save(); this.updateDock(); toast('偏移已歸零'); };

    // seek bar and volume (YouTube and demo; Spotify access is read-only)
    const seek = $('#seek');
    seek.addEventListener('input', () => { this.scrubbing = true; const t = this.track; if (t) $('#tCur').textContent = fmtTime(seek.value / 1000 * t.duration); });
    seek.addEventListener('change', () => { const t = this.track; if (t) this.seekTo(seek.value / 1000 * t.duration); this.scrubbing = false; this.tCurS = ''; this.scrubV = ''; });
    $('#vol').addEventListener('input', ev => { if (this.src && this.src.setVolume) this.src.setVolume(+ev.target.value); });

    // click a lyric line to jump there, double-click elsewhere to play/pause
    const cv = this.canvas;
    const at = ev => { const b = cv.getBoundingClientRect(); return [(ev.clientX - b.left) * cv.width / b.width, (ev.clientY - b.top) * cv.height / b.height]; };
    const lineAt = ev => (this.src && this.src.canSeek ? this.r.hitLine(...at(ev)) : -1);
    cv.addEventListener('click', ev => { const i = lineAt(ev); if (i >= 0) this.seekTo(this.r.lyr.entries[i].time + this.S.offset + 0.02); });
    cv.addEventListener('dblclick', ev => { if (lineAt(ev) < 0 && this.src && this.src.togglePlay) this.src.togglePlay(); });
    cv.addEventListener('pointermove', ev => cv.classList.toggle('seekable', lineAt(ev) >= 0));

    // drag & drop .lrc
    let depth = 0;
    addEventListener('dragenter', ev => { if (ev.dataTransfer && [...ev.dataTransfer.types].includes('Files')) { depth++; document.body.classList.add('dragging'); } });
    addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
    addEventListener('dragover', ev => ev.preventDefault());
    addEventListener('drop', ev => {
      ev.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) this.importFile(f);
    });

    // YouTube card can be dragged out of the way (YouTube requires the player to stay visible, at least 200 × 200)
    const card = $('#ytcard'), head = $('#ytcard .ythead');
    head.addEventListener('pointerdown', ev => {
      const r = card.getBoundingClientRect(), ox = ev.clientX - r.left, oy = ev.clientY - r.top;
      head.setPointerCapture(ev.pointerId);
      const move = e => { card.style.left = clamp(e.clientX - ox, 0, innerWidth - r.width) + 'px'; card.style.top = clamp(e.clientY - oy, 0, innerHeight - r.height) + 'px'; card.style.right = 'auto'; card.style.bottom = 'auto'; };
      const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); };
      head.addEventListener('pointermove', move); head.addEventListener('pointerup', up);
    });

    this.kbNav = false;
    addEventListener('keydown', ev => { if (ev.key === 'Tab') this.kbNav = true; }, true);
    addEventListener('pointerdown', () => { this.kbNav = false; }, true);
    addEventListener('keydown', ev => this.onKey(ev));
    // a mouse click should not leave focus on the button (Space would press it again)
    document.addEventListener('click', ev => { const b = ev.target.closest && ev.target.closest('.ui button, .recbar button'); if (b && ev.detail > 0 && !b.closest('.menu')) b.blur(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && this.src && this.src.onVisible) this.src.onVisible(); });

    // hide the interface when the mouse rests
    let idleT = 0;
    const wake = () => {
      document.body.classList.remove('idle');
      clearTimeout(idleT);
      idleT = setTimeout(() => {
        if (!document.querySelector('dialog[open]') && !this.menu && !document.querySelector('.ui :hover') && !document.querySelector('.ui :focus-visible')) document.body.classList.add('idle');
      }, 2600);
    };
    ['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach(e => addEventListener(e, wake, { passive: true }));
    wake();
  },
  openSettings() {
    $('#setKaraoke').checked = !!this.S.karaoke;
    $('#setBlur').checked = !!this.S.blur;
    $('#setInfo').checked = !!this.S.showInfo;
    $('#setCredit').checked = !!this.S.credit;
    $('#setAlign').value = this.S.align;
    $('#setScale').value = String(this.S.scale);
    $('#scaleVal').textContent = Math.round(this.S.scale * 100) + '%';
    $('#dlgSettings').showModal();
  },
  onKey(ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (this.cdCancel && ev.key === 'Escape') { ev.preventDefault(); this.cancelCountdown(); return; }
    const tgt = document.activeElement && document.activeElement.closest ? document.activeElement : null;
    if (tgt && tgt.closest('input, select, textarea')) return; // typing never triggers shortcuts
    if (document.querySelector('dialog[open]') || this.menu) return;
    const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    const actions = {
      ' ': () => { if (this.src && this.src.togglePlay) this.src.togglePlay(); },
      l: () => this.openSearch(),
      '[': () => this.nudge(ev.shiftKey ? -0.5 : -0.1), '{': () => this.nudge(-0.5),
      ']': () => this.nudge(ev.shiftKey ? 0.5 : 0.1), '}': () => this.nudge(0.5),
      t: () => this.cycleTheme(),
      v: () => this.cycleLayout(),
      f: () => this.toggleFull(),
      r: () => this.openRec(),
      p: () => { if (this.rec.state === 'paused') this.rec.resume(); else this.rec.pause(); },
      h: () => document.body.classList.toggle('hideui'),
      ArrowLeft: () => { if (this.src && this.src.seek) this.src.seek(-5); },
      ArrowRight: () => { if (this.src && this.src.seek) this.src.seek(5); },
    };
    if (!actions[k]) return; // Tab, Escape, Enter… keep their normal meaning
    const btn = tgt && tgt.closest('button');
    if (btn) {
      // keyboard users who tabbed to a button keep Space/Enter for it; after a mouse click the shortcut wins
      if (ev.key === ' ' && this.kbNav) return;
      btn.blur();
    }
    ev.preventDefault(); // otherwise the key also lands in the text box of the dialog it opens
    actions[k]();
  },
};

window.LyricsStudio = App;
document.addEventListener('DOMContentLoaded', () => App.init());
