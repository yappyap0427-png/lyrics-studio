'use strict';
/* ---------- small helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
/* frame-rate independent exponential approach */
const approach = (cur, target, dt, k) => cur + (target - cur) * (1 - Math.exp(-dt * k));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const easeOut = t => 1 - Math.pow(1 - t, 3);
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* localStorage can throw (privacy modes, embedded frames, quota) — never let it break the app */
const Store = {
  get(k, d) { try { const v = localStorage.getItem('ls.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('ls.' + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem('ls.' + k); } catch (e) { /* ignore */ } },
};

/* how the page was opened decides what can work: Spotify wants https or a loopback IP,
   the YouTube player needs a real web origin, recording needs a secure context */
const Env = {
  kind() {
    if (location.protocol === 'file:') return 'file';
    const h = location.hostname;
    if (h === 'localhost' || h.endsWith('.localhost')) return 'localhost';
    if (location.protocol === 'https:') return 'https';
    if (h === '127.0.0.1' || h === '[::1]') return 'loopback';
    return 'http';
  },
  can(feature) {
    const k = this.kind();
    if (feature === 'spotify') return k === 'https' || k === 'loopback';
    if (feature === 'youtube') return k !== 'file';
    if (feature === 'record') return !!window.isSecureContext;
    return true;
  },
};

/* fetch that gives up after `ms` and can also be cancelled by the caller's signal */
async function fetchT(url, opts = {}, ms = 10000) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
  const outer = opts.signal;
  const onOuter = () => ctl.abort();
  if (outer) { if (outer.aborted) ctl.abort(); else outer.addEventListener('abort', onOuter, { once: true }); }
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
  } catch (e) {
    if (timedOut) throw Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' });
    throw e;
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onOuter);
  }
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  let r, g, b;
  if (s === 0) { r = g = b = l; } else {
    const f = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0);
  return { c, ctx: c.getContext('2d') };
}

/* crossOrigin=anonymous: a host without CORS fails to load instead of tainting the canvas
   (a tainted canvas can no longer be recorded) */
function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('IMG_LOAD'));
    img.src = url;
  });
}

function roundRect(x, X, Y, W, H, r) {
  r = Math.max(0, Math.min(r, W / 2, H / 2));
  x.beginPath();
  x.moveTo(X + r, Y);
  x.arcTo(X + W, Y, X + W, Y + H, r);
  x.arcTo(X + W, Y + H, X, Y + H, r);
  x.arcTo(X, Y + H, X, Y, r);
  x.arcTo(X, Y, X + W, Y, r);
  x.closePath();
}

function ellipsize(x, text, maxW) {
  text = String(text || '');
  if (x.measureText(text).width <= maxW) return text;
  const chars = Array.from(text);
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (x.measureText(chars.slice(0, mid).join('') + '…').width <= maxW) lo = mid; else hi = mid - 1;
  }
  return chars.slice(0, lo).join('').trimEnd() + '…';
}

function randomString(n) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += chars[b % chars.length];
  return s;
}
async function sha256b64url(str) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  let bin = '';
  for (const b of new Uint8Array(d)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* Chinese .lrc files are often GBK or Big5, not UTF-8: pick the decoding that yields the most common characters */
const COMMON_HAN = '的一是不了人我在有他這这中大來来上國国個个到說说們们為为子和你地出道也時时年得就那要下以生會会自著着去之過过家學学對对可她裡里後后小麼么心多天而能好都然沒没日於于起還还發发成事只作當当想看文無无開开手十用主行方又如前所本見见經经頭头面公同三已老從从動动兩两長长知民樣样現现分將将外但身些與与高意進进把法此實实回二理美點点月明其種种聲声全工己話话兒儿者向情部正名定女問问力機机給给等幾几很業业最間间新什打便位因重被走電电四第門门相次東东政海口使教西再平真聽听世氣气信北少關关並并內内加化由卻却代軍军產产入先山五太水萬万市眼體体別别處处總总才場场師师書书愛爱夢梦風风雨淚泪笑走路愛夜光';
function decodeText(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { /* not UTF-8 */ }
  let best = null, bestScore = -Infinity;
  for (const enc of ['gb18030', 'big5', 'shift_jis', 'euc-kr', 'windows-1252']) {
    let s;
    try { s = new TextDecoder(enc).decode(b); } catch (e) { continue; }
    let score = 0;
    for (const ch of s) { if (ch === '�') score -= 5; else if (COMMON_HAN.includes(ch)) score += 1; }
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best != null ? best : new TextDecoder('utf-8').decode(b);
}

/* toasts: ms = 0 keeps it on screen until closed (for errors the user has to act on) */
let toastTimer = 0;
function toast(msg, ms = 3400) {
  const el = $('#toast');
  if (!el) return;
  const m = el.querySelector('.msg') || el;
  m.textContent = msg;
  el.classList.add('show');
  el.classList.toggle('sticky', ms === 0);
  clearTimeout(toastTimer);
  if (ms > 0) toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
function hideToast() { const el = $('#toast'); if (el) el.classList.remove('show'); clearTimeout(toastTimer); }

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function safeName(s) {
  return (String(s || 'lyrics').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'lyrics').slice(0, 60);
}
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
