/* ---------- app: wires sources → clock → lyrics → renderer, plus all the UI ---------- */
const LAYOUTS = ['fit', '16:9', '9:16', '1:1'];
const LAYOUT_LABEL = { fit: '填滿', '16:9': '16:9', '9:16': '9:16', '1:1': '1:1' };
const LAYOUT_SIZE = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1440, 1440] };
const SOURCE_NAME = { spotify: 'Spotify', youtube: 'YouTube', demo: '示範' };
const IDLE_TEXT = {
  'spotify-login': ['還沒連接 Spotify', '點上方的 Spotify 完成設定'],
  'spotify-nothing': ['Spotify 目前沒有在播放', '在任何裝置上播一首歌，這裡就會跟著顯示'],
  'spotify-ad': ['廣告播放中', '廣告結束後會接回歌詞'],
  'spotify-episode': ['正在播放 Podcast', 'Podcast 沒有同步歌詞'],
  'spotify-denied': ['Spotify 拒絕存取', '開發模式需要 App 擁有者有 Premium'],
  'youtube-empty': ['貼上一首歌的連結', '點上方的 YouTube 開始'],
};

const App = {
  init() {
    this.S = Object.assign({
      source: 'demo', theme: 'flow', layout: 'fit', offset: 0,
      karaoke: true, blur: true, align: 'auto', scale: 1, showInfo: true,
      recAudio: 'none', recFps: 60, recQuality: 'high', recAutoStop: true,
    }, Store.get('settings', {}));
    if (!LAYOUTS.includes(this.S.layout)) this.S.layout = 'fit';
    const canvas = $('#stage');
    this.clock = new Clock();
    this.track = null; this.idleReason = null; this.lyrTok = 0; this.statusText = '';
    this.r = new Renderer(canvas);
    this.r.onPalette = p => this.applyPalette(p);
    this.r.onPerfLow = () => toast('畫面有點吃力，已自動關閉遠處模糊', 5000);
    this.r.setTheme(this.S.theme);
    this.r.setOpts({ karaoke: this.S.karaoke, blur: this.S.blur, align: this.S.align, scale: this.S.scale, showInfo: this.S.showInfo });
    this.rec = new Recorder(canvas);
    this.rec.onstate = (on, blob, type) => this.onRecState(on, blob, type);
    this.sources = { spotify: new SpotifySource(this), youtube: new YouTubeSource(this), demo: new DemoSource(this) };
    this.bindUI();
    this.resize();
    addEventListener('resize', () => this.resize());
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', () => { this.r.layoutDirty = true; });

    const q = new URLSearchParams(location.search);
    if (q.has('code') || q.has('error')) this.sources.spotify.handleRedirect().finally(() => this.setSource('spotify'));
    else this.setSource(this.S.source);

    this.updateDock();
    this.last = performance.now();
    requestAnimationFrame(() => this.frame());
    if (location.protocol === 'file:') toast('請用 start.bat 開啟：直接點兩下 HTML 檔會連不到 Spotify 和 YouTube', 9000);
  },
  save() { Store.set('settings', this.S); },

  frame() {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const songT = this.track ? this.clock.now(now) : 0;
    this.r.draw(songT, songT - this.S.offset, dt, this.clock.playing);
    if (this.rec.active) {
      const s = fmtTime(this.rec.elapsed());
      if (this.recShown !== s) { this.recShown = s; $('#recTime').textContent = s; }
    }
    requestAnimationFrame(() => this.frame());
  },

  /* ---------- playback events from the sources ---------- */
  onPlayback(track, pos, playing, ts = performance.now()) {
    this.idleReason = null;
    if (!this.track || this.track.key !== track.key) {
      if (this.rec.active && this.S.recAutoStop && this.track) { this.rec.stop(); toast('換歌了，已停止錄影'); }
      this.track = track;
      this.clock.sync(pos, playing, ts, true);
      this.r.setTrack(track);
      this.loadLyrics(track);
    } else {
      const pred = this.clock.now(ts);
      if (this.rec.active && this.S.recAutoStop && pos + 2 < pred && pred > (track.duration || 0) - 4) { this.rec.stop(); toast('歌曲播完，已停止錄影'); }
      this.clock.sync(pos, playing, ts);
      if (track.duration && !this.track.duration) this.track.duration = track.duration;
    }
    this.setStatus(this.S.source === 'demo' ? '示範模式' : `${SOURCE_NAME[this.S.source]} ${playing ? '播放中' : '已暫停'}`);
  },
  onIdle(reason) {
    if (this.idleReason === reason && !this.track) return;
    this.idleReason = reason;
    if (this.track) { this.track = null; this.r.setTrack(null); }
    this.lyrTok++;
    const [note, hint] = IDLE_TEXT[reason] || ['等待播放', ''];
    this.r.setLyrics({ status: 'idle', note, hint });
    this.setStatus(reason === 'spotify-login' ? 'Spotify 未連接' : `${SOURCE_NAME[this.S.source]} 待命`);
  },
  setStatus(text) { if (text !== this.statusText) { this.statusText = text; $('#status').textContent = text; } },

  /* ---------- lyrics ---------- */
  async loadLyrics(track, opts = {}) {
    const tok = ++this.lyrTok;
    if (track.lrc) { this.applyLrc(track.lrc, track); return; }
    const imported = Store.get('lrcImport.' + track.key, null);
    if (imported) { this.applyLrc(imported, track); return; }
    this.r.setLyrics({ status: 'loading' });
    try {
      const rec = await Lyrics.find(track, opts);
      if (tok !== this.lyrTok) return;
      this.applyRecord(rec, track);
    } catch (e) {
      if (tok !== this.lyrTok) return;
      console.warn('[lyrics]', e);
      this.r.setLyrics({ status: 'error', note: e.message === 'RATE_LIMIT' ? '歌詞資料庫請求太頻繁，等幾秒再按 L 重試' : '連不到歌詞資料庫 lrclib.net，檢查網路後按 L 重試' });
    }
  },
  applyRecord(rec, track) {
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
  importLrc(text, name) {
    const t = this.track;
    if (!t) { toast('先播放一首歌，再匯入歌詞'); return; }
    Store.set('lrcImport.' + t.key, text);
    Store.del('lyricsPick.' + t.key);
    this.lyrTok++;
    this.applyLrc(text, t);
    toast('已匯入 ' + name);
  },
  resetLyrics() {
    const t = this.track;
    if (!t) return;
    Store.del('lrcImport.' + t.key); Store.del('lyricsPick.' + t.key);
    Lyrics.clearCache(t.key);
    this.loadLyrics(t, { force: true });
    toast('改回自動配對');
  },

  /* ---------- sources ---------- */
  setSource(name) {
    if (!this.sources[name]) name = 'demo';
    if (this.src) this.src.stop();
    this.S.source = name; this.save();
    this.track = null; this.idleReason = null; this.lyrTok++;
    this.r.setTrack(null);
    this.r.setLyrics({ status: 'idle', note: '等待播放' });
    this.clock.sync(0, false, performance.now(), true);
    $$('.seg button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.src === name)));
    this.src = this.sources[name];
    this.src.start();
    if (name === 'spotify' && !this.sources.spotify.token) this.openSpotify();
    if (name === 'youtube' && !this.sources.youtube.videoId) this.openYoutube();
  },
  showYtCard(on) { $('#ytcard').hidden = !on; },

  /* ---------- dialogs ---------- */
  openSpotify() {
    const sp = this.sources.spotify, prob = sp.originProblem(), w = $('#spWarn');
    $('#spRedirect').textContent = sp.redirectUri();
    $('#spClient').value = sp.clientId || '';
    $('#spLogout').hidden = !sp.token;
    w.hidden = !prob;
    w.textContent = prob === 'file' ? '請用 start.bat 開啟程式。直接打開 HTML 檔無法登入 Spotify。'
      : prob === 'localhost' ? 'Spotify 不接受 localhost。請改用 http://127.0.0.1:8888/ 開啟這個頁面。'
      : prob === 'http' ? 'Spotify 只接受 127.0.0.1 或 https 網址，請用 start.bat 開啟。' : '';
    $('#dlgSpotify').showModal();
  },
  openYoutube() { $('#ytUrl').value = Store.get('yt.last', ''); $('#dlgYoutube').showModal(); setTimeout(() => $('#ytUrl').select(), 30); },
  openSearch() {
    const t = this.track;
    $('#q').value = t ? [Lyrics.cleanTitle(t.title), String(t.artist || '').split(',')[0]].join(' ').trim() : '';
    $('#results').replaceChildren();
    $('#btnAuto').hidden = !t;
    $('#dlgSearch').showModal();
    if ($('#q').value) this.doSearch();
  },
  msgItem(text) { const li = document.createElement('li'); li.className = 'msg'; li.textContent = text; return li; },
  async doSearch() {
    const q = $('#q').value.trim(), ul = $('#results');
    if (!q) return;
    const tok = (this.searchTok = (this.searchTok || 0) + 1);
    ul.replaceChildren(this.msgItem('搜尋中…'));
    try {
      const list = await Lyrics.search({ q });
      if (tok !== this.searchTok) return;
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
        b.onclick = () => {
          const cur = this.track;
          if (!cur) { toast('先播放一首歌，再套用歌詞'); return; }
          Store.set('lyricsPick.' + cur.key, r.id); Store.del('lrcImport.' + cur.key);
          Lyrics.clearCache(cur.key);
          this.lyrTok++;
          this.applyRecord(r, cur);
          $('#dlgSearch').close();
          toast('已套用這份歌詞');
        };
        li.appendChild(b); ul.appendChild(li);
      }
    } catch (e) {
      if (tok !== this.searchTok) return;
      ul.replaceChildren(this.msgItem(e.message === 'RATE_LIMIT' ? '請求太頻繁，等幾秒再試' : '連不到 lrclib.net，檢查網路後再試'));
    }
  },
  openRec() {
    if (this.rec.active) { this.rec.stop(); return; }
    const f = $('#recForm');
    f.aud.value = this.S.recAudio;
    $('#recFps').value = String(this.S.recFps);
    $('#recQ').value = this.S.recQuality;
    $('#recAuto').checked = !!this.S.recAutoStop;
    const c = $('#stage');
    $('#recSize').textContent = `${c.width} × ${c.height}`;
    this.updateRecHint();
    $('#dlgRec').showModal();
  },
  updateRecHint() {
    const aud = $('#recForm').aud.value, sp = this.S.source === 'spotify';
    const lines = [];
    if (aud === 'system' || aud === 'both') lines.push(sp ? '按開始後會跳出分享視窗：選「整個螢幕」，並打開「分享系統音訊」。' : '按開始後會跳出分享視窗：選「這個分頁」，並打開「分享分頁音訊」。');
    if (aud === 'mic' || aud === 'both') lines.push('戴耳機錄，麥克風才不會收到喇叭的聲音。');
    if (aud === 'none') lines.push('只錄畫面，之後可以在剪輯軟體配上音樂。');
    if (this.S.layout !== '9:16') lines.push('要發 TikTok 或 Reels，先按 V 把比例切到 9:16。');
    lines.push('錄影時讓這個分頁保持在最前面，切走畫面會停格。');
    $('#recHint').textContent = lines.join(' ');
  },
  startRec(ev) {
    ev.preventDefault();
    const f = $('#recForm');
    this.S.recAudio = f.aud.value;
    this.S.recFps = parseInt($('#recFps').value, 10) || 60;
    this.S.recQuality = $('#recQ').value;
    this.S.recAutoStop = $('#recAuto').checked;
    this.save();
    $('#dlgRec').close();
    this.rec.start({
      audio: this.S.recAudio, fps: this.S.recFps,
      bitrate: this.S.recQuality === 'high' ? 16e6 : 8e6,
      preferTab: this.S.source !== 'spotify',
    }).catch(err => {
      const code = (err && (err.code || err.name)) || '';
      if (code === 'NO_SHARED_AUDIO') toast('沒有收到聲音：分享時要打開「分享音訊」，再試一次', 7000);
      else if (code === 'NotAllowedError') toast('分享或麥克風權限被取消了，沒有開始錄影', 6000);
      else if (code === 'UNSUPPORTED') toast('這個瀏覽器不能錄影，請用最新版 Chrome 或 Edge', 7000);
      else toast('無法開始錄影：' + ((err && err.message) || code), 7000);
    });
  },
  onRecState(on, blob, type) {
    document.body.classList.toggle('recording', on);
    $('#recbar').hidden = !on;
    $('#btnRec .lbl').textContent = on ? '停止' : '錄影';
    $('#btnLayout').disabled = on;
    if (on) { this.recShown = ''; return; }
    this.resize();
    if (!blob) return;
    if (blob.size < 2000) { toast('錄到的檔案是空的，可能分頁被切到背景了', 6000); return; }
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const name = `${safeName(this.track ? this.track.title : 'lyrics')}-${stamp()}.${ext}`;
    downloadBlob(blob, name);
    toast(`已存成 ${name}（${(blob.size / 1048576).toFixed(1)} MB）`, 7000);
  },

  /* ---------- view controls ---------- */
  nudge(d) {
    this.S.offset = Math.round((this.S.offset + d) * 10) / 10;
    if (Math.abs(this.S.offset) < 0.05) this.S.offset = 0;
    this.save(); this.updateDock();
  },
  cycleTheme() {
    const i = THEME_ORDER.indexOf(this.S.theme);
    this.S.theme = THEME_ORDER[(i + 1) % THEME_ORDER.length];
    this.r.setTheme(this.S.theme); this.save(); this.updateDock();
    toast('風格：' + THEMES[this.S.theme].label, 1600);
  },
  cycleLayout() {
    if (this.rec.active) { toast('錄影中不能換比例'); return; }
    const i = LAYOUTS.indexOf(this.S.layout);
    this.S.layout = LAYOUTS[(i + 1) % LAYOUTS.length];
    this.save(); this.resize(); this.updateDock();
    toast('畫面比例：' + LAYOUT_LABEL[this.S.layout] + (this.S.layout === 'fit' ? '（跟著視窗）' : `（${LAYOUT_SIZE[this.S.layout].join(' × ')}）`), 2000);
  },
  updateDock() {
    const o = this.S.offset;
    $('#offVal').textContent = (o > 0 ? '+' : '') + o.toFixed(1) + 's';
    $('#btnTheme').textContent = THEMES[this.S.theme].label;
    $('#btnLayout').textContent = LAYOUT_LABEL[this.S.layout];
  },
  toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => toast('這個瀏覽器不允許全螢幕'));
  },
  resize() {
    const c = $('#stage');
    let W, H;
    if (this.rec && this.rec.active) { W = c.width; H = c.height; } // never change size mid-recording
    else if (LAYOUT_SIZE[this.S.layout]) [W, H] = LAYOUT_SIZE[this.S.layout];
    else {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = Math.round(innerWidth * dpr); H = Math.round(innerHeight * dpr);
      const k = Math.min(1, 2560 / Math.max(W, H));
      W = Math.round(W * k); H = Math.round(H * k);
    }
    W -= W % 2; H -= H % 2;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; this.r.resize(W, H); }
    const s = Math.min(innerWidth / W, innerHeight / H);
    c.style.width = Math.round(W * s) + 'px';
    c.style.height = Math.round(H * s) + 'px';
  },
  applyPalette(p) {
    const st = document.documentElement.style;
    st.setProperty('--accent', p.accent.map(v => v | 0).join(' '));
    st.setProperty('--tint', p.dark.map(v => v | 0).join(' '));
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
    $('#btnTheme').onclick = () => this.cycleTheme();
    $('#btnLayout').onclick = () => this.cycleLayout();
    $('#btnFull').onclick = () => this.toggleFull();
    $('#btnRec').onclick = () => this.openRec();
    $('#recStop').onclick = () => this.rec.stop();
    $('#btnSettings').onclick = () => this.openSettings();

    $('#spCopy').onclick = () => {
      const v = $('#spRedirect').textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(() => toast('已複製 Redirect URI'), () => toast('複製失敗，請手動選取'));
    };
    $('#spConnect').onclick = () => {
      const id = $('#spClient').value.trim();
      if (!/^[0-9a-f]{32}$/i.test(id)) { toast('Client ID 應該是 32 個英文和數字'); $('#spClient').focus(); return; }
      if (this.sources.spotify.originProblem()) { toast('目前的網址不能登入 Spotify，請照上面的提示用 127.0.0.1 開啟', 6000); return; }
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
    $('#lrcFile').addEventListener('change', async ev => {
      const f = ev.target.files && ev.target.files[0];
      if (f) { this.importLrc(await f.text(), f.name); $('#dlgSearch').close(); }
      ev.target.value = '';
    });
    $('#recForm').addEventListener('submit', ev => this.startRec(ev));
    $('#recForm').addEventListener('change', () => this.updateRecHint());
    $('#recCancel').onclick = () => $('#dlgRec').close();
    $$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));

    // settings
    const bindCheck = (id, key) => $(id).addEventListener('change', ev => { this.S[key] = ev.target.checked; this.save(); this.r.setOpts({ [key]: this.S[key] }); if (key === 'blur' && this.S.blur) this.r.perfLow = false; });
    bindCheck('#setKaraoke', 'karaoke'); bindCheck('#setBlur', 'blur'); bindCheck('#setInfo', 'showInfo');
    $('#setAlign').addEventListener('change', ev => { this.S.align = ev.target.value; this.save(); this.r.setOpts({ align: this.S.align }); });
    $('#setScale').addEventListener('input', ev => { this.S.scale = parseFloat(ev.target.value) || 1; this.save(); this.r.setOpts({ scale: this.S.scale }); $('#scaleVal').textContent = Math.round(this.S.scale * 100) + '%'; });
    $('#setOffReset').onclick = () => { this.S.offset = 0; this.save(); this.updateDock(); toast('偏移已歸零'); };

    // drag & drop .lrc
    let depth = 0;
    addEventListener('dragenter', ev => { if (ev.dataTransfer && [...ev.dataTransfer.types].includes('Files')) { depth++; document.body.classList.add('dragging'); } });
    addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
    addEventListener('dragover', ev => ev.preventDefault());
    addEventListener('drop', async ev => {
      ev.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) this.importLrc(await f.text(), f.name);
    });

    // YouTube card can be dragged out of the way
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
    document.addEventListener('click', ev => { const b = ev.target.closest && ev.target.closest('.ui button, .recbar button'); if (b && ev.detail > 0) b.blur(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && this.rec.active) toast('剛才切到別的分頁，那段影片會停格', 5000); });

    // hide the interface when the mouse rests
    let idleT = 0;
    const wake = () => {
      document.body.classList.remove('idle');
      clearTimeout(idleT);
      idleT = setTimeout(() => { if (!document.querySelector('dialog[open]') && !document.querySelector('.ui :hover')) document.body.classList.add('idle'); }, 2600);
    };
    ['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach(e => addEventListener(e, wake, { passive: true }));
    wake();
  },
  openSettings() {
    $('#setKaraoke').checked = !!this.S.karaoke;
    $('#setBlur').checked = !!this.S.blur;
    $('#setInfo').checked = !!this.S.showInfo;
    $('#setAlign').value = this.S.align;
    $('#setScale').value = String(this.S.scale);
    $('#scaleVal').textContent = Math.round(this.S.scale * 100) + '%';
    $('#dlgSettings').showModal();
  },
  onKey(ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const tgt = document.activeElement && document.activeElement.closest ? document.activeElement : null;
    if (tgt && tgt.closest('input, select, textarea')) return;
    if (document.querySelector('dialog[open]')) return;
    const btn = tgt && tgt.closest('button');
    if (btn) {
      // keyboard users who tabbed to a button keep Space/Enter for it; after a mouse click the shortcut wins
      if (ev.key === 'Enter' || (ev.key === ' ' && this.kbNav)) return;
      btn.blur();
    }
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
      h: () => document.body.classList.toggle('hideui'),
      ArrowLeft: () => { if (this.src && this.src.seek) this.src.seek(-5); },
      ArrowRight: () => { if (this.src && this.src.seek) this.src.seek(5); },
    };
    if (!actions[k]) return;
    ev.preventDefault(); // otherwise the key also lands in the text box of the dialog it opens
    actions[k]();
  },
};

window.LyricsStudio = App;
document.addEventListener('DOMContentLoaded', () => App.init());
