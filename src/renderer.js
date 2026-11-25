/* ---------- canvas renderer: everything drawn here is what gets recorded ---------- */
const FONT_SANS = '"Outfit", "Noto Sans TC", "Noto Sans SC", "Noto Sans CJK TC", "Microsoft JhengHei", "PingFang TC", "Heiti TC", sans-serif';
const FONT_SERIF = '"Fraunces", "Noto Serif TC", "Noto Serif SC", "Noto Serif CJK TC", "PMingLiU", "Songti TC", serif';

/* every visual difference between styles lives here, so a new style is one new entry */
const THEMES = {
  flow: {
    label: '流光', desc: '封面顏色流動，唱到哪亮到哪', mode: 'scroll', font: 'sans', weight: 800,
    size: [60, 68], gapK: 0.62, rowK: 1.2, align: null, inactiveScale: 0.955,
    inA: [0.27, 0.36], unA: 0.40, glow: 0.7, softBehind: 0.45,
    dim: 0.30, vignette: 0.5, grain: 0.055, grainFps: 0, sat: 1.55, blur: 7, kenBurns: false, credit: false, ink: [255, 255, 255],
  },
  serif: {
    label: '明體', desc: '襯線字置中，比較安靜', mode: 'scroll', font: 'serif', weight: 600,
    size: [54, 62], gapK: 0.95, rowK: 1.4, align: 'center', inactiveScale: 0.97,
    inA: [0.20, 0.27], unA: 0.30, glow: 0.22, softBehind: 1.4,
    dim: 0.42, vignette: 0.62, grain: 0.09, grainFps: 0, sat: 1.12, blur: 9, kenBurns: false, credit: false, ink: [255, 244, 228],
  },
  cinema: {
    label: '電影', desc: '上下黑邊，一次一行字幕', mode: 'subtitle', font: 'sans', weight: 500,
    size: [46, 56], gapK: 0.62, rowK: 1.32, align: 'center', inactiveScale: 1,
    inA: [0.3, 0.3], unA: 1, glow: 0, softBehind: 0,
    dim: 0.34, vignette: 0.75, grain: 0.12, grainFps: 24, sat: 1.05, blur: 4, kenBurns: true, credit: true, ink: [255, 255, 255],
  },
};
const THEME_ORDER = ['flow', 'serif', 'cinema'];
const famOf = T => (T.font === 'serif' ? FONT_SERIF : FONT_SANS);

const CJK_CHAR = /[⺀-⿿　-〿぀-ヿ㄀-ㄯ㐀-䶿一-鿿가-힯豈-﫿︰-﹏＀-￯]/;
const CLOSE_PUNCT = /^[，。！？、；：）」』】》〉…,.!?;:)\]’”]/;

function tokenize(text) {
  const out = [];
  let buf = '';
  for (const ch of Array.from(text)) {
    if (CJK_CHAR.test(ch)) { if (buf) { out.push(buf); buf = ''; } out.push(ch); }
    else if (ch === ' ') { buf += ch; out.push(buf); buf = ''; }
    else buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}
/* map each visible row character back to its index in the full line (rows drop wrap spaces) */
function mapRows(rows, tc) {
  let p = 0;
  for (const r of rows) {
    r.map = [];
    for (const ch of r.chars) {
      while (p < tc.length && tc[p] !== ch) p++;
      r.map.push(Math.min(p, tc.length - 1));
      p++;
    }
  }
}
function rowFill(r, P) {
  const m = r.map;
  if (!m || !m.length || P <= m[0]) return 0;
  if (P >= m[m.length - 1] + 1) return m.length;
  for (let j = 0; j < m.length; j++) if (P < m[j] + 1) return j + Math.max(0, P - m[j]);
  return m.length;
}
function charTimes(words) {
  const st = [], en = [];
  for (const w of words) {
    const ch = Array.from(w.text);
    const end = w.end != null ? w.end : w.start + 0.4 * ch.length;
    const d = (end - w.start) / Math.max(1, ch.length);
    ch.forEach((_, k) => { st.push(w.start + d * k); en.push(w.start + d * (k + 1)); });
  }
  return { st, en };
}

class Renderer {
  constructor(canvas) {
    this.c = canvas;
    this.x = canvas.getContext('2d', { alpha: false });
    this.theme = 'flow';
    this.opts = { karaoke: true, blur: true, align: 'auto', scale: 1, showInfo: true, credit: true };
    this.track = null;
    this.artImg = null; this.artSmall = null; this.artMid = null; this.artCrop = null; this.artAlpha = 0; this.artTok = 0;
    this.palette = Palette.fromString('Lyrics Studio');
    this.lyr = { status: 'idle', entries: [], plain: [], note: '', hint: '' };
    this.anim = 0; this.artScale = 1; this.bgFade = 1; this.prevBg = null; this.bgAcc = 0; this.bgDirty = true;
    this.reduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.perfLow = false; this.ft = 1 / 60; this.slowFor = 0; this.warm = 0;
    this.grain = this.makeGrain(128); this.grainPat = null; this.grainCtx = null;
    this.cine = { cur: -2, prev: -2, t0: 0 };
    this.mcache = new Map(); this.fontSeen = new Map();
    this.snap = true; this.curLine = '';
    this.resize(canvas.width, canvas.height);
  }
  get T() { return THEMES[this.theme]; }
  makeGrain(n) {
    const { c, ctx } = makeCanvas(n, n);
    const d = ctx.createImageData(n, n);
    for (let i = 0; i < d.data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255;
    }
    ctx.putImageData(d, 0, 0);
    return c;
  }
  resize(W, H) {
    this.W = W; this.H = H;
    const land = W >= H;
    const bw = land ? 160 : Math.round(160 * W / H), bh = land ? Math.round(160 * H / W) : 160;
    this.bgS = makeCanvas(bw, bh); this.bgB = makeCanvas(bw, bh);
    this.bgFull = makeCanvas(W, H); this.grainCtx = null;
    this.prevBg = null; this.bgFade = 1; this.bgDirty = true;
    this.layoutDirty = true; this.snap = true;
  }
  setTheme(name) {
    if (!THEMES[name]) name = 'flow';
    if (name === this.theme && !this.layoutDirty) return;
    this.theme = name; this.layoutDirty = true; this.snap = true; this.bgDirty = true; this.cine.cur = -2;
    this.preloadFonts();
  }
  setOpts(o) { Object.assign(this.opts, o); this.layoutDirty = true; this.snap = true; }
  fontsChanged() { this.mcache.clear(); this.layoutDirty = true; }

  /* ---------- track + art ---------- */
  setTrack(track) {
    this.snapshotBg();
    if (this.artMid && this.artAlpha > 0.05) { this.prevArtMid = this.artMid; this.prevArtA = this.artAlpha; }
    this.track = track;
    this.artImg = null; this.artSmall = null; this.artMid = null; this.artAlpha = 0;
    this.palette = Palette.fromString(track ? track.title + track.artist : 'Lyrics Studio');
    this.emitPalette();
    const tok = ++this.artTok;
    this.cine.cur = -2;
    if (!track) return;
    this.preloadFonts();
    if (track.artCanvas) { this.useArt(track.artCanvas); return; }
    const urls = !track.art ? [] : Array.isArray(track.art) ? track.art : [track.art];
    (async () => {
      for (let i = 0; i < urls.length; i++) {
        try {
          const img = await loadImage(urls[i]);
          if (tok !== this.artTok) return;
          if ((img.naturalWidth || 0) <= 121 && i < urls.length - 1) continue; // YouTube's "no thumbnail" placeholder
          this.useArt(img);
          return;
        } catch (e) { /* try next */ }
      }
    })();
  }
  snapshotBg() {
    if (!this.bgB) return;
    const { c, ctx } = makeCanvas(this.bgB.c.width, this.bgB.c.height);
    ctx.drawImage(this.bgB.c, 0, 0);
    this.prevBg = c; this.bgFade = 0; this.bgDirty = true;
  }
  useArt(img) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    let cy = 0, ch = h;
    if (this.track && this.track.source === 'youtube' && Math.abs(w / h - 4 / 3) < 0.03) { cy = h * 0.125; ch = h * 0.75; } // 4:3 thumbnail with letterbox bars
    const s = Math.min(w, ch);
    const crop = [(w - s) / 2, cy + (ch - s) / 2, s, s];
    const pal = Palette.fromImage(img, crop);
    if (!pal) return; // unreadable image would taint the canvas and break recording
    this.artCrop = crop;
    this.palette = pal; this.emitPalette();
    const sm = makeCanvas(96, 96);
    sm.ctx.drawImage(img, crop[0], crop[1], crop[2], crop[3], 0, 0, 96, 96);
    const md = makeCanvas(720, 720); // softened copy for the 電影 background
    md.ctx.filter = 'blur(1.2px)';
    md.ctx.drawImage(img, crop[0], crop[1], crop[2], crop[3], -4, -4, 728, 728);
    this.snapshotBg();
    this.artSmall = sm.c; this.artMid = md.c; this.artImg = img; this.artAlpha = 0;
  }
  emitPalette() {
    const a = this.palette.avg || [80, 80, 80];
    const lum = (0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]) / 255;
    this.dimExtra = clamp((lum - 0.26) * 0.85, 0, 0.32); // bright covers get a darker backdrop so text keeps contrast
    this.bgDirty = true;
    if (this.onPalette) this.onPalette(this.palette);
  }

  setLyrics(state) {
    this.lyr = Object.assign({ status: 'idle', entries: [], plain: [], note: '', hint: '' }, state);
    this.layoutDirty = true; this.snap = true; this.cine.cur = -2; this.plainY = null;
    this.preloadFonts();
  }
  /* web fonts load per character range: ask only for characters not requested before, then re-measure */
  preloadFonts() {
    if (!document.fonts || !document.fonts.load) return;
    const T = this.T, fam = famOf(T);
    const txt = (this.lyr.entries || []).map(e => (e.text || '') + (e.sub || '')).join('') + (this.lyr.plain || []).join('') +
      (this.track ? this.track.title + this.track.artist : '') + '正在找歌詞找不到同步純音樂等待播放0123456789:';
    const chars = Array.from(new Set(Array.from(txt)));
    const jobs = [];
    for (const f of [`${T.weight} 48px ${fam}`, `700 48px ${fam}`, `500 48px ${FONT_SANS}`]) {
      let seen = this.fontSeen.get(f);
      if (!seen) this.fontSeen.set(f, (seen = new Set()));
      const fresh = chars.filter(c => !seen.has(c));
      if (!fresh.length) continue;
      fresh.forEach(c => seen.add(c));
      jobs.push(document.fonts.load(f, fresh.join('').slice(0, 3000)));
    }
    if (jobs.length) Promise.all(jobs).then(() => this.fontsChanged()).catch(() => {});
  }

  /* ---------- geometry ---------- */
  geom() {
    const T = this.T, { W, H } = this;
    const ar = W / H, land = ar >= 1.25, u = Math.min(W, H) / 1080, s = this.opts.scale || 1;
    const g = { W, H, u, land };
    g.font = T.size[land ? 0 : 1] * u * s;
    g.gap = g.font * T.gapK;
    g.rowH = g.font * T.rowK;
    if (T.mode === 'subtitle') {
      g.bar = land ? Math.max(0, (H - W / 2.39) / 2) : 0;
      g.subY = land ? H - g.bar - 120 * u : H * 0.74;
      g.maxW = land ? W * 0.7 : W * 0.84;
      g.cx = W / 2; g.lw = g.maxW; g.lx = (W - g.maxW) / 2; g.align = 'center';
      return g;
    }
    const info = this.opts.showInfo;
    if (land) {
      g.artSize = Math.min(W * 0.27, H * 0.46);
      g.artX = W * 0.085; g.artY = H * 0.5 - g.artSize * 0.62;
      g.infoX = g.artX; g.infoY = g.artY + g.artSize + 40 * u; g.infoW = g.artSize;
      g.lx = info ? W * 0.45 : W * 0.12; g.lw = info ? W * 0.47 : W * 0.76;
      g.top = H * 0.06; g.bottom = H * 0.94; g.anchor = H * 0.4;
    } else {
      const tall = ar < 0.8;
      g.header = true;
      g.artSize = (tall ? 190 : 150) * u;
      g.artX = W * 0.075; g.artY = (tall ? 150 : 72) * u;
      g.infoX = g.artX + g.artSize + 34 * u; g.infoW = W - g.infoX - W * 0.075;
      g.lx = W * 0.075; g.lw = W * 0.85;
      g.top = info ? g.artY + g.artSize + 120 * u : H * 0.08;
      g.bottom = H * 0.95;
      g.anchor = g.top + (g.bottom - g.top) * (info ? 0.3 : 0.36);
    }
    g.align = this.opts.align === 'auto' ? (T.align || (land ? 'left' : 'center')) : this.opts.align;
    g.cx = g.lx + g.lw / 2;
    return g;
  }
  mainFont(px) { const T = this.T; return `${T.weight} ${px.toFixed(1)}px ${famOf(T)}`; }
  subFont(px) { return `500 ${px.toFixed(1)}px ${famOf(this.T)}`; }

  /* measureText is the slow part of layout; widths only change when the font does */
  measure(s) {
    const key = this.x.font + '\u0001' + s;
    let w = this.mcache.get(key);
    if (w === undefined) {
      w = this.x.measureText(s).width;
      if (this.mcache.size > 40000) this.mcache.clear();
      this.mcache.set(key, w);
    }
    return w;
  }
  wrap(text, maxW) {
    const toks = tokenize(text);
    const run = lim => {
      const rows = [];
      let cur = '', w = 0;
      for (let tk of toks) {
        const tw = this.measure(tk);
        if (tw > lim && tk.trim().length > 1) { // a single word wider than the line: break it
          for (const ch of Array.from(tk)) {
            const cw = this.measure(ch);
            if (cur.trim() && w + cw > lim) { rows.push(cur); cur = ''; w = 0; }
            cur += ch; w += cw;
          }
          continue;
        }
        if (cur.trim() && w + tw > lim && !CLOSE_PUNCT.test(tk)) {
          rows.push(cur);
          tk = tk.replace(/^\s+/, '');
          cur = tk; w = this.measure(tk);
        } else { cur += tk; w += tw; }
      }
      if (cur.trim()) rows.push(cur);
      return rows;
    };
    let rows = run(maxW);
    if (rows.length > 1) { // balance rows so the last one isn't a lonely word
      const total = rows.reduce((a, r) => a + this.measure(r.trim()), 0);
      let lim = (total / rows.length) * 1.06;
      for (let k = 0; k < 8 && lim < maxW; k++) {
        const alt = run(lim);
        if (alt.length === rows.length) { rows = alt; break; }
        lim *= 1.05;
      }
    }
    return rows.map(r => { const t = r.trim(); return { text: t, chars: Array.from(t), w: this.measure(t) }; });
  }

  layout() {
    const g = (this.g = this.geom());
    const x = this.x;
    const E = this.lyr.entries || [];
    if (this.T.mode === 'scroll') {
      const subPx = g.font * 0.5;
      for (const e of E) {
        const prev = e.L || {};
        e.C = null;
        if (e.type === 'gap') { e.L = { h: 0, gapH: g.font * 1.05, hh: prev.hh || 0, y: prev.y, lv: 0 }; continue; }
        x.font = this.mainFont(g.font);
        const rows = this.wrap(e.text, g.lw);
        let subRows = [];
        if (e.sub) { x.font = this.subFont(subPx); subRows = this.wrap(e.sub, g.lw); }
        const tc = Array.from(e.text);
        mapRows(rows, tc);
        const h = rows.length * g.rowH + (subRows.length ? g.font * 0.16 + subRows.length * subPx * 1.38 : 0);
        e.L = { rows, subRows, subPx, h, hh: h, textLen: tc.length, y: this.snap ? undefined : prev.y, s: prev.s, lv: prev.lv || 0, charT: e.words ? charTimes(e.words) : null };
      }
      if (this.lyr.status === 'plain') {
        x.font = this.mainFont(g.font * 0.7);
        this.plainRows = (this.lyr.plain || []).map(t => (t.trim() ? this.wrap(t.trim(), g.lw) : []));
      }
    } else {
      for (const e of E) e.C = null;
    }
    this.layoutDirty = false;
  }

  /* ---------- frame ---------- */
  draw(songT, lyricT, dt, playing) {
    this.anim += dt;
    this.artAlpha = approach(this.artAlpha, this.artImg ? 1 : 0, dt, 4);
    if (this.layoutDirty) this.layout();
    const x = this.x;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.filter = 'none';
    x.shadowColor = 'transparent'; x.shadowBlur = 0; x.shadowOffsetX = 0; x.shadowOffsetY = 0;
    this.drawBackground(dt);
    if (this.T.mode === 'subtitle') this.drawCinema(songT, lyricT, dt);
    else {
      if (this.opts.showInfo) this.drawInfo(songT, dt, playing);
      this.drawLyrics(lyricT, dt);
    }
    this.monitor(dt);
  }
  monitor(dt) {
    this.warm += dt;
    if (this.warm < 4 || this.perfLow || !this.opts.blur) return;
    this.ft = this.ft * 0.96 + dt * 0.04;
    if (this.ft > 1 / 38) {
      this.slowFor += dt;
      if (this.slowFor > 3) { this.perfLow = true; if (this.onPerfLow) this.onPerfLow(); }
    } else this.slowFor = Math.max(0, this.slowFor - dt);
  }

  /* the backdrop moves slowly, so it is rebuilt off-screen ~30 times a second (24 for film grain)
     and each frame only copies it */
  drawBackground(dt) {
    const T = this.T;
    this.bgAcc += dt;
    const step = 1 / (T.grainFps || 30);
    if (this.bgDirty || this.bgAcc >= step) {
      this.renderBackground(Math.min(this.bgAcc, 0.25));
      this.bgAcc = 0; this.bgDirty = false;
    }
    this.x.drawImage(this.bgFull.c, 0, 0);
  }
  renderBackground(dt) {
    const x = this.bgFull.ctx, W = this.W, H = this.H, T = this.T, P = this.palette;
    const S = this.bgS, B = this.bgB, sw = S.c.width, sh = S.c.height, sx = S.ctx;
    const tt = this.anim * (this.reduced ? 0.2 : 1);
    sx.globalAlpha = 1; sx.globalCompositeOperation = 'source-over';
    sx.fillStyle = rgba(P.dark, 1); sx.fillRect(0, 0, sw, sh);
    if (this.artSmall) {
      const big = Math.max(sw, sh);
      const layers = [[1.75, 0.035, 0.28, 0.32, 1], [1.45, -0.05, 0.78, 0.62, 0.9], [1.2, 0.065, 0.42, 0.86, 0.75], [0.95, -0.08, 0.86, 0.16, 0.65]];
      layers.forEach(([sc, rot, px, py, a], i) => {
        const size = big * sc;
        const cx = sw * (px + 0.14 * Math.sin(tt * 0.13 + i * 1.7));
        const cy = sh * (py + 0.14 * Math.cos(tt * 0.11 + i * 2.3));
        sx.save();
        sx.globalAlpha = a;
        sx.translate(cx, cy); sx.rotate(tt * rot + i * 1.3);
        sx.drawImage(this.artSmall, -size / 2, -size / 2, size, size);
        sx.restore();
      });
    } else {
      const cols = P.colors;
      for (let i = 0; i < 4; i++) {
        const c = cols[i % cols.length];
        const cx = sw * (0.5 + 0.36 * Math.sin(tt * (0.09 + i * 0.023) + i * 2.1));
        const cy = sh * (0.5 + 0.36 * Math.cos(tt * (0.07 + i * 0.019) + i * 1.3));
        const r = Math.max(sw, sh) * (0.5 + 0.12 * i);
        const gr = sx.createRadialGradient(cx, cy, 0, cx, cy, r);
        gr.addColorStop(0, rgba(c, 0.95)); gr.addColorStop(1, rgba(c, 0));
        sx.fillStyle = gr; sx.fillRect(0, 0, sw, sh);
      }
    }
    const bx = B.ctx, m = 14;
    bx.filter = 'none'; bx.globalAlpha = 1;
    bx.fillStyle = rgba(P.dark, 1); bx.fillRect(0, 0, sw, sh);
    bx.filter = `blur(${T.blur}px) saturate(${T.sat}) brightness(0.84)`;
    bx.drawImage(S.c, -m, -m, sw + 2 * m, sh + 2 * m);
    bx.filter = 'none';

    x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(B.c, 0, 0, W, H);
    if (this.prevBg && this.bgFade < 1) {
      this.bgFade = Math.min(1, this.bgFade + dt / 1.1);
      x.globalAlpha = 1 - easeInOut(this.bgFade);
      x.drawImage(this.prevBg, 0, 0, W, H);
      x.globalAlpha = 1;
      if (this.bgFade >= 1) this.prevBg = null;
    }
    if (T.kenBurns) { // the cover itself, slowly drifting like a film still
      if (this.prevArtMid) {
        this.prevArtA -= dt / 1.1;
        if (this.prevArtA <= 0) this.prevArtMid = null; else this.kenBurns(x, this.prevArtMid, this.prevArtA);
      }
      if (this.artMid && this.artAlpha > 0.01) this.kenBurns(x, this.artMid, this.artAlpha);
    }
    x.fillStyle = `rgba(0,0,0,${clamp(T.dim + (this.dimExtra || 0), 0, 0.8)})`; x.fillRect(0, 0, W, H);
    const vg = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.max(W, H) * 0.78);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,0,${T.vignette})`);
    x.fillStyle = vg; x.fillRect(0, 0, W, H);
    this.grainOn(x);
  }
  kenBurns(x, img, alpha) {
    const W = this.W, H = this.H;
    const tt = this.anim * (this.reduced ? 0.15 : 1);
    const zoom = 1.12 + 0.05 * Math.sin(tt * 0.045);
    const s = Math.max(W, H) * zoom;
    const cx = W / 2 + Math.sin(tt * 0.031) * W * 0.035;
    const cy = H / 2 + Math.cos(tt * 0.027) * H * 0.035;
    x.save();
    x.globalAlpha = clamp(alpha, 0, 1);
    x.drawImage(img, cx - s / 2, cy - s / 2, s, s);
    x.restore();
  }
  grainOn(x) {
    const T = this.T;
    if (!T.grain) return;
    if (this.grainCtx !== x) { this.grainPat = x.createPattern(this.grain, 'repeat'); this.grainCtx = x; }
    const ox = T.grainFps && !this.reduced ? (Math.random() * 128) | 0 : 0, oy = T.grainFps && !this.reduced ? (Math.random() * 128) | 0 : 0;
    x.save();
    x.globalAlpha = T.grain; x.globalCompositeOperation = 'overlay';
    x.translate(-ox, -oy);
    x.fillStyle = this.grainPat;
    x.fillRect(ox, oy, this.W, this.H);
    x.restore();
  }

  drawInfo(songT, dt, playing) {
    const g = this.g, x = this.x, u = g.u, T = this.T, tr = this.track, P = this.palette;
    this.artScale = approach(this.artScale, playing || !tr ? 1 : 0.92, dt, 5);
    const S = g.artSize * this.artScale, ax = g.artX + (g.artSize - S) / 2, ay = g.artY + (g.artSize - S) / 2;
    const rad = g.artSize * 0.045;
    x.save();
    x.shadowColor = 'rgba(0,0,0,0.42)'; x.shadowBlur = 48 * u; x.shadowOffsetY = 18 * u;
    roundRect(x, ax, ay, S, S, rad); x.fillStyle = rgba(P.colors[0], 1); x.fill();
    x.restore();
    x.save();
    roundRect(x, ax, ay, S, S, rad); x.clip();
    const pg = x.createLinearGradient(ax, ay, ax + S, ay + S);
    pg.addColorStop(0, rgba(P.colors[0], 1)); pg.addColorStop(1, rgba(P.colors[2] || P.dark, 1));
    x.fillStyle = pg; x.fillRect(ax, ay, S, S);
    if (this.artImg && this.artAlpha > 0.01) {
      x.globalAlpha = this.artAlpha;
      x.drawImage(this.artImg, this.artCrop[0], this.artCrop[1], this.artCrop[2], this.artCrop[3], ax, ay, S, S);
      x.globalAlpha = 1;
    }
    if (this.artAlpha < 0.99) {
      x.globalAlpha = 1 - this.artAlpha;
      x.fillStyle = 'rgba(255,255,255,0.55)'; x.font = `500 ${(S * 0.28).toFixed(1)}px ${FONT_SANS}`;
      x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('♪', ax + S / 2, ay + S / 2);
      x.globalAlpha = 1;
    }
    x.restore();
    x.save();
    roundRect(x, ax + 0.5, ay + 0.5, S - 1, S - 1, rad);
    x.strokeStyle = 'rgba(255,255,255,0.10)'; x.lineWidth = Math.max(1, 1.2 * u); x.stroke();
    x.restore();
    if (!tr) return;

    const fam = famOf(T);
    const dur = tr.duration || 0, pos = clamp(songT, 0, dur || Math.max(0, songT));
    x.save();
    x.textAlign = 'left'; x.textBaseline = 'alphabetic';
    if (!g.header) {
      let y = g.infoY + 34 * u;
      x.font = `700 ${(34 * u).toFixed(1)}px ${fam}`; x.fillStyle = '#fff';
      x.fillText(ellipsize(x, tr.title, g.infoW), g.infoX, y);
      y += 40 * u;
      x.font = `500 ${(25 * u).toFixed(1)}px ${fam}`; x.fillStyle = 'rgba(255,255,255,0.64)';
      x.fillText(ellipsize(x, tr.artist, g.infoW), g.infoX, y);
      this.drawProgress(g.infoX, y + 30 * u, g.infoW, u, pos, dur);
    } else {
      let y = g.artY + g.artSize * 0.44;
      x.font = `700 ${(40 * u).toFixed(1)}px ${fam}`; x.fillStyle = '#fff';
      x.fillText(ellipsize(x, tr.title, g.infoW), g.infoX, y);
      y += 48 * u;
      x.font = `500 ${(28 * u).toFixed(1)}px ${fam}`; x.fillStyle = 'rgba(255,255,255,0.64)';
      x.fillText(ellipsize(x, tr.artist, g.infoW), g.infoX, y);
      this.drawProgress(g.lx, g.artY + g.artSize + 42 * u, g.lw, u, pos, dur);
    }
    x.restore();
  }
  drawProgress(X, Y, Wd, u, pos, dur) {
    const x = this.x, h = 5 * u, p = dur ? clamp(pos / dur, 0, 1) : 0;
    roundRect(x, X, Y, Wd, h, h / 2); x.fillStyle = 'rgba(255,255,255,0.18)'; x.fill();
    if (p > 0) { roundRect(x, X, Y, Math.max(h, Wd * p), h, h / 2); x.fillStyle = 'rgba(255,255,255,0.88)'; x.fill(); }
    x.font = `500 ${(18 * u).toFixed(1)}px ${FONT_SANS}`; x.fillStyle = 'rgba(255,255,255,0.55)'; x.textBaseline = 'top';
    x.textAlign = 'left'; x.fillText(fmtTime(pos), X, Y + h + 10 * u);
    x.textAlign = 'right'; if (dur) x.fillText('-' + fmtTime(Math.max(0, dur - pos)), X + Wd, Y + h + 10 * u);
    x.textAlign = 'left';
  }

  /* ---------- scrolling lyrics (流光 / 明體) ---------- */
  drawLyrics(t, dt) {
    const g = this.g, E = this.lyr.entries, T = this.T;
    if (this.lyr.status !== 'synced' || !E.length) { this.curLine = ''; this.drawLyricState(t, dt); return; }
    let ai = LRC.activeIndex(E, t);
    if (ai > 0 && E[ai].type === 'gap' && !E[ai].show) ai--; // short breath: keep the last line lit
    this.curLine = ai >= 0 && E[ai].type === 'line' ? E[ai].text : '';
    const focus = Math.max(0, ai);
    const snap = this.snap; this.snap = false;
    for (let i = 0; i < E.length; i++) {
      if (E[i].type !== 'gap') continue;
      const L = E[i].L, target = i === ai && E[i].show ? L.gapH : 0;
      L.hh = snap ? target : approach(L.hh || 0, target, dt, 8);
    }
    const ys = this._ys || (this._ys = []);
    ys.length = E.length;
    let acc = 0;
    for (let i = 0; i < E.length; i++) {
      ys[i] = acc;
      const L = E[i].L;
      if (E[i].type === 'gap') acc += L.hh + g.gap * (L.hh / L.gapH);
      else acc += L.h + g.gap;
    }
    const base = g.anchor - ys[focus] + (ai < 0 ? g.rowH * 1.2 : 0);
    const k0 = this.reduced ? 18 : 6.5;
    for (let i = 0; i < E.length; i++) {
      const L = E[i].L, target = base + ys[i], d = Math.abs(i - focus);
      L.y = L.y == null || snap ? target : approach(L.y, target, dt, k0 / (1 + d * 0.11)); // farther lines trail a little
      const act = i === ai ? 1 : 0;
      L.lv = snap ? act : approach(L.lv || 0, act, dt, act ? 7 : 4.5);
      const ts = act ? 1 : T.inactiveScale;
      L.s = L.s == null || snap ? ts : approach(L.s, ts, dt, 6);
    }
    const fadeLen = (g.bottom - g.top) * 0.16;
    for (let i = 0; i < E.length; i++) {
      const e = E[i], L = e.L, y = L.y;
      const h = e.type === 'gap' ? L.hh : L.h;
      if (y > g.bottom + g.rowH || y + h < g.top - g.rowH) continue;
      const mid = y + h * 0.5;
      const fade = clamp((mid - g.top) / fadeLen, 0, 1) * clamp((g.bottom - mid) / fadeLen, 0, 1);
      if (fade <= 0.005) continue;
      if (e.type === 'gap') { if (L.hh > 0.5) this.drawDots(e, L, t, fade); continue; }
      const d = Math.abs(i - focus);
      const blur = this.opts.blur && !this.perfLow && !this.reduced ? Math.min(3, Math.max(0, d - 1)) * 1.15 * g.u : 0;
      this.drawLine(e, L, i, ai, t, fade, blur);
    }
  }
  /* which lyric line is under a point on the canvas (for click-to-jump) */
  hitLine(px, py) {
    if (this.T.mode !== 'scroll' || this.lyr.status !== 'synced' || !this.g) return -1;
    const g = this.g, E = this.lyr.entries;
    if (px < g.lx - g.font * 0.5 || px > g.lx + g.lw + g.font * 0.5 || py < g.top || py > g.bottom) return -1;
    for (let i = 0; i < E.length; i++) {
      const e = E[i], L = e.L;
      if (!L || e.type !== 'line' || L.y == null) continue;
      if (py >= L.y - g.gap / 2 && py <= L.y + L.h + g.gap / 2) return i;
    }
    return -1;
  }

  charX(r, n) {
    if (!r.pre || r.preFont !== this.x.font) {
      r.pre = [0];
      for (let k = 1; k <= r.chars.length; k++) r.pre.push(this.measure(r.chars.slice(0, k).join('')));
      r.preFont = this.x.font;
    }
    const k = Math.floor(n), f = n - k;
    if (k >= r.chars.length) return r.pre[r.chars.length];
    return r.pre[k] + (r.pre[k + 1] - r.pre[k]) * f;
  }
  progressChars(e, t) {
    const L = e.L;
    if (L.charT) {
      const { st, en } = L.charT;
      if (!st.length || t < st[0]) return 0;
      let lo = 0, hi = st.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (st[mid] <= t) lo = mid; else hi = mid - 1; }
      return lo + clamp((t - st[lo]) / Math.max(0.01, en[lo] - st[lo]), 0, 1);
    }
    return clamp((t - e.time) / Math.max(0.2, e.fillEnd - e.time), 0, 1) * L.textLen;
  }

  drawLine(e, L, i, ai, t, alpha, blur) {
    const x = this.x, g = this.g, T = this.T, u = g.u, col = T.ink;
    const lv = clamp(L.lv, 0, 1);
    const inA = i < ai ? T.inA[0] : T.inA[1];
    const unA = lerp(inA, T.unA, lv), fiA = lerp(inA, 1, lv);
    const ox = g.align === 'center' ? g.cx : g.lx;
    const y0 = L.y;
    const karaoke = this.opts.karaoke && lv > 0.002;
    const P = karaoke ? this.progressChars(e, t) : 0;
    /* the lit edge eases in behind the sung position and never reaches ahead of it */
    const behind = g.font * T.softBehind, ahead = g.font * 0.1;
    x.save();
    x.globalAlpha = alpha;
    x.translate(ox, y0); x.scale(L.s, L.s); x.translate(-ox, -y0);
    if (blur > 0.3) x.filter = `blur(${blur.toFixed(1)}px)`;
    x.font = this.mainFont(g.font); x.textBaseline = 'middle'; x.textAlign = 'left';
    let yy = y0 + g.rowH / 2;
    for (const r of L.rows) {
      const rx = g.align === 'center' ? g.cx - r.w / 2 : g.lx;
      const n = karaoke ? rowFill(r, P) : 0;
      const lit = !karaoke ? 1 : n >= r.chars.length ? 1 : n <= 0 ? 0 : -1; // -1 = partly sung
      let g0 = 0, g1 = 0;
      if (lit === -1) { const px = rx + this.charX(r, n); g0 = px - behind; g1 = px + ahead; }
      if (T.glow && lv > 0.02 && lit !== 0) {
        x.save();
        x.filter = `blur(${(16 * u).toFixed(1)}px)`;
        x.globalAlpha = alpha * T.glow * lv;
        if (lit === 1) x.fillStyle = rgba(this.palette.accent, 1);
        else {
          const gg = x.createLinearGradient(g0, 0, g1, 0);
          gg.addColorStop(0, rgba(this.palette.accent, 1)); gg.addColorStop(1, rgba(this.palette.accent, 0));
          x.fillStyle = gg;
        }
        x.fillText(r.text, rx, yy);
        x.restore();
        if (blur > 0.3) x.filter = `blur(${blur.toFixed(1)}px)`;
      }
      if (!karaoke) x.fillStyle = rgba(col, lerp(inA, 1, lv));
      else if (lit === 1) x.fillStyle = rgba(col, fiA);
      else if (lit === 0) x.fillStyle = rgba(col, unA);
      else {
        const gr = x.createLinearGradient(g0, 0, g1, 0);
        gr.addColorStop(0, rgba(col, fiA)); gr.addColorStop(1, rgba(col, unA));
        x.fillStyle = gr;
      }
      x.fillText(r.text, rx, yy);
      yy += g.rowH;
    }
    if (L.subRows && L.subRows.length) {
      x.font = this.subFont(L.subPx);
      x.fillStyle = rgba(col, lerp(inA * 0.9, 0.74, lv));
      let sy = y0 + L.rows.length * g.rowH + g.font * 0.16 + L.subPx * 0.69;
      for (const r of L.subRows) {
        x.fillText(r.text, g.align === 'center' ? g.cx - r.w / 2 : g.lx, sy);
        sy += L.subPx * 1.38;
      }
    }
    x.restore();
  }

  /* interlude: three dots that fill up across the instrumental */
  drawDots(e, L, t, fade) {
    const x = this.x, g = this.g, col = this.T.ink;
    const h = L.hh, show = clamp(h / L.gapH, 0, 1);
    const p = clamp((t - e.time) / Math.max(0.3, e.end - e.time), 0, 1);
    const out = clamp((e.end - t) / 0.45, 0, 1);
    const r = g.font * 0.12, sp = g.font * 0.4, cy = L.y + h / 2;
    const x0 = g.align === 'center' ? g.cx - sp : g.lx + r * 1.2;
    for (let k = 0; k < 3; k++) {
      const kp = clamp(p * 3 - k, 0, 1);
      const br = 1 + 0.16 * Math.sin(this.anim * 2.4 - k * 0.8);
      const a = (0.25 + 0.75 * kp) * show * fade * (0.3 + 0.7 * out);
      const rr = r * br * (0.6 + 0.4 * show) * (1 + 0.3 * (1 - out));
      x.beginPath(); x.arc(x0 + k * sp, cy, rr, 0, Math.PI * 2);
      x.fillStyle = rgba(col, a); x.fill();
    }
  }

  stateText() {
    switch (this.lyr.status) {
      case 'loading': return ['正在找歌詞', ''];
      case 'notfound': return ['找不到同步歌詞', '按 L 手動搜尋，或把 LRC 檔拖進視窗'];
      case 'instrumental': return ['純音樂', '這首歌沒有歌詞'];
      case 'off': return ['這首不顯示歌詞', '按 L 可以改回自動配對'];
      case 'error': return ['歌詞載入失敗', this.lyr.note || '按 L 重新搜尋'];
      default: return [this.lyr.note || '等待播放', this.lyr.hint || ''];
    }
  }
  drawLyricState(t, dt) {
    if (this.lyr.status === 'plain') { this.drawPlain(t, dt); return; }
    const x = this.x, g = this.g, T = this.T;
    const [title, hint] = this.stateText();
    const fam = famOf(T);
    const cx = g.align === 'center' ? g.cx : g.lx;
    const pulse = this.lyr.status === 'loading' ? 0.55 + 0.35 * Math.sin(this.anim * 3) : 0.92;
    x.save();
    x.textBaseline = 'middle'; x.textAlign = g.align === 'center' ? 'center' : 'left';
    x.font = `${T.weight} ${(g.font * 0.8).toFixed(1)}px ${fam}`; x.fillStyle = rgba(T.ink, pulse);
    x.fillText(ellipsize(x, title, g.lw), cx, g.anchor);
    if (hint) {
      x.font = `500 ${(g.font * 0.38).toFixed(1)}px ${fam}`; x.fillStyle = rgba(T.ink, 0.58);
      x.fillText(ellipsize(x, hint, g.lw), cx, g.anchor + g.font * 0.95);
    }
    x.restore();
  }
  drawPlain(t, dt) {
    const x = this.x, g = this.g, T = this.T, list = this.plainRows || [];
    const px = g.font * 0.7, rh = px * 1.34, gp = px * 0.45;
    let total = 0;
    for (const rows of list) total += rows.length * rh + gp;
    const dur = (this.track && this.track.duration) || 1;
    const view = g.bottom - g.top;
    const target = g.top + view * 0.18 - Math.max(0, total - view * 0.6) * clamp(t / dur, 0, 1);
    this.plainY = this.plainY == null ? target : approach(this.plainY, target, dt, 2);
    x.save();
    x.font = this.mainFont(px); x.textBaseline = 'middle'; x.textAlign = 'left';
    const fadeLen = view * 0.16;
    let y = this.plainY;
    for (const rows of list) {
      for (const r of rows) {
        const cy = y + rh / 2;
        const f = clamp((cy - g.top) / fadeLen, 0, 1) * clamp((g.bottom - cy) / fadeLen, 0, 1);
        if (f > 0.01) { x.fillStyle = rgba(T.ink, 0.8 * f); x.fillText(r.text, g.align === 'center' ? g.cx - r.w / 2 : g.lx, cy); }
        y += rh;
      }
      y += gp;
    }
    x.restore();
  }

  /* ---------- 電影: one subtitle line at a time ---------- */
  cineRows(e) {
    const g = this.g, x = this.x;
    if (!e.C || e.C.font !== g.font) {
      x.font = `${this.T.weight} ${g.font.toFixed(1)}px ${FONT_SANS}`;
      const rows = this.wrap(e.text, g.maxW);
      let sub = [];
      if (e.sub) { x.font = `400 ${(g.font * 0.62).toFixed(1)}px ${FONT_SANS}`; sub = this.wrap(e.sub, g.maxW); }
      e.C = { font: g.font, rows, sub };
    }
    return e.C;
  }
  drawCinema(songT, t, dt) {
    const x = this.x, g = this.g, W = this.W, H = this.H, u = g.u, tr = this.track, T = this.T;
    if (g.bar > 0) { x.fillStyle = '#000'; x.fillRect(0, 0, W, Math.ceil(g.bar)); x.fillRect(0, Math.floor(H - g.bar), W, Math.ceil(g.bar)); }
    if (tr && T.credit && this.opts.credit !== false) { // opening credit for the first seconds of the song
      const ca = clamp((songT - 0.6) / 1.4, 0, 1) * clamp((8 - songT) / 1.6, 0, 1);
      if (ca > 0.005) {
        x.save();
        x.globalAlpha = ca; x.textAlign = 'left'; x.textBaseline = 'alphabetic';
        const X = W * 0.08, Y = (g.bar || H * 0.07) + 96 * u;
        x.shadowColor = 'rgba(0,0,0,0.5)'; x.shadowBlur = 12 * u;
        x.font = `600 ${(42 * u).toFixed(1)}px ${FONT_SERIF}`; x.fillStyle = '#fff';
        x.fillText(ellipsize(x, tr.title, W * 0.6), X, Y);
        x.font = `400 ${(24 * u).toFixed(1)}px ${FONT_SANS}`; x.fillStyle = 'rgba(255,255,255,0.72)';
        x.fillText(ellipsize(x, tr.artist, W * 0.6), X, Y + 42 * u);
        x.restore();
      }
    }
    const st = this.lyr.status, E = this.lyr.entries;
    if (st !== 'synced' || !E.length) {
      this.curLine = '';
      const msg = st === 'plain' ? '這首只有未同步的歌詞，換成流光或明體風格來看' : this.stateText()[0];
      x.save();
      x.font = `500 ${(g.font * 0.62).toFixed(1)}px ${FONT_SANS}`; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillStyle = `rgba(255,255,255,${st === 'loading' ? 0.45 + 0.3 * Math.sin(this.anim * 3) : 0.7})`;
      x.fillText(msg, g.cx, g.subY);
      x.restore();
      return;
    }
    let ai = LRC.activeIndex(E, t);
    if (ai >= 0 && E[ai].type === 'gap') ai = E[ai].show ? -1 : ai - 1;
    this.curLine = ai >= 0 && E[ai].type === 'line' ? E[ai].text : '';
    const C = this.cine;
    if (ai !== C.cur) { C.prev = C.cur; C.cur = ai; C.t0 = this.anim; }
    const ef = easeOut(clamp((this.anim - C.t0) / 0.5, 0, 1));
    x.save();
    x.textAlign = 'left'; x.textBaseline = 'middle';
    x.shadowColor = 'rgba(0,0,0,0.7)'; x.shadowBlur = 14 * u; x.shadowOffsetY = 2 * u;
    const fs = g.font;
    const drawSub = (idx, a, dy) => {
      if (idx < 0 || a <= 0.005 || !E[idx] || E[idx].type !== 'line') return;
      const c = this.cineRows(E[idx]);
      const rh = fs * 1.32, srh = fs * 0.62 * 1.36;
      const total = c.rows.length * rh + (c.sub.length ? fs * 0.12 + c.sub.length * srh : 0);
      let y = g.subY - total / 2 + rh / 2 + dy;
      x.globalAlpha = a;
      x.font = `${T.weight} ${fs.toFixed(1)}px ${FONT_SANS}`; x.fillStyle = '#fff';
      for (const r of c.rows) { x.fillText(r.text, g.cx - r.w / 2, y); y += rh; }
      if (c.sub.length) {
        y += fs * 0.12 - rh / 2 + srh / 2;
        x.font = `400 ${(fs * 0.62).toFixed(1)}px ${FONT_SANS}`; x.fillStyle = 'rgba(255,255,255,0.82)';
        for (const r of c.sub) { x.fillText(r.text, g.cx - r.w / 2, y); y += srh; }
      }
    };
    drawSub(C.prev, 1 - ef, -8 * u * ef);
    drawSub(C.cur, ef, 8 * u * (1 - ef));
    x.restore();
  }
}
