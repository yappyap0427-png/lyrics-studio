/* ---------- LRCLIB client (free synced-lyrics database, CORS enabled) ---------- */
const Lyrics = (() => {
  const API = 'https://lrclib.net/api';
  const CLIENT = 'LyricsStudio/1.0 (personal lyrics player)';
  let headerOk = true, last = 0, blockedUntil = 0;
  const cache = new Map();

  async function call(path) {
    const now = performance.now();
    if (now < blockedUntil) await sleep(blockedUntil - now);
    const wait = last + 300 - performance.now(); // requests one at a time, gently spaced
    if (wait > 0) await sleep(wait);
    last = performance.now();
    let res;
    try {
      res = await fetch(API + path, headerOk ? { headers: { 'Lrclib-Client': CLIENT } } : undefined);
    } catch (e) {
      if (!headerOk) throw e;
      headerOk = false; // custom header refused by the CORS preflight: retry without it
      res = await fetch(API + path);
    }
    if (res.status === 429) {
      const ra = parseFloat(res.headers.get('Retry-After')) || 10;
      blockedUntil = performance.now() + ra * 1000 * (1 + Math.random() * 0.3);
      throw new Error('RATE_LIMIT');
    }
    return res;
  }
  async function json(path) {
    const r = await call(path);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP_' + r.status);
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new Error('BAD_RESPONSE');
    return r.json();
  }
  const qs = o => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const get = p => json('/get?' + qs(p));
  const search = p => json('/search?' + qs(p)).then(r => (Array.isArray(r) ? r : []));
  const byId = id => json('/get/' + encodeURIComponent(id));

  function cleanTitle(s) {
    return String(s || '')
      .replace(/\s*[-–—]\s*(\d{4}\s*)?(remaster(ed)?|re-?master(ed)?|live|mono|stereo|single|radio edit|edit|version|mix|demo)\b.*$/i, '')
      .replace(/\s*[(\[（【][^)\]）】]*(feat\.?|ft\.?|with |remaster|version|live|edit|mix|from |theme|ost|插曲|主題曲|片尾曲|片頭曲)[^)\]）】]*[)\]）】]/gi, '')
      .trim();
  }
  const tight = s => String(s || '').toLowerCase().normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
  const firstArtist = a => String(a || '').split(/,|&|、| x |feat\.|ft\./i)[0].trim();

  function score(r, t) {
    let s = 0;
    const a = tight(cleanTitle(t.title)), b = tight(cleanTitle(r.trackName || r.name));
    if (a && b) { if (a === b) s += 4; else if (a.includes(b) || b.includes(a)) s += 2.2; }
    const ta = tight(t.artist), ra = tight(r.artistName), fa = tight(firstArtist(t.artist));
    if (ta && ra && (ta === ra || ta.includes(ra) || ra.includes(ta) || (fa && (ra.includes(fa) || fa.includes(ra))))) s += 3;
    if (t.duration && r.duration) {
      const d = Math.abs(r.duration - t.duration);
      s += d <= 2 ? 3 : d <= 4 ? 2 : d <= 8 ? 0.5 : d <= 20 ? -1 : -4;
    }
    if (r.syncedLyrics) s += 2;
    if (r.instrumental) s += 0.5;
    return s;
  }
  function best(list, t, min = 5) {
    let top = null, ts = -Infinity;
    for (const r of list) { const sc = score(r, t); if (sc > ts) { ts = sc; top = r; } }
    return top && ts >= min ? top : null;
  }
  const usable = r => r && (r.syncedLyrics || r.instrumental);

  async function find(t, { force = false } = {}) {
    if (!force && cache.has(t.key)) return cache.get(t.key);
    const manual = Store.get('lyricsPick.' + t.key, null);
    if (manual) {
      try { const r = await byId(manual); if (r) { cache.set(t.key, r); return r; } } catch (e) { if (e.message === 'RATE_LIMIT') throw e; }
    }
    const artist0 = firstArtist(t.artist);
    const dur = t.duration ? Math.round(t.duration) : undefined;
    let rec = null, plain = null;
    const soft = async fn => { try { return await fn(); } catch (e) { if (e.message === 'RATE_LIMIT') throw e; return null; } };

    if (t.title && artist0) {
      const r = await soft(() => get({ track_name: t.title, artist_name: artist0, album_name: t.album, duration: dur }));
      if (usable(r)) rec = r; else if (r && r.plainLyrics) plain = r;
      const ct = cleanTitle(t.title);
      if (!rec && (ct !== t.title || t.album)) {
        const r2 = await soft(() => get({ track_name: ct, artist_name: artist0, duration: dur }));
        if (usable(r2)) rec = r2; else if (r2 && r2.plainLyrics) plain = plain || r2;
      }
    }
    if (!rec && t.title) {
      const lists = [];
      lists.push(...((await soft(() => search({ track_name: cleanTitle(t.title), artist_name: artist0 || undefined }))) || []));
      if (!lists.some(r => r.syncedLyrics)) lists.push(...((await soft(() => search({ q: [cleanTitle(t.title), artist0].filter(Boolean).join(' ') }))) || []));
      if (!lists.some(r => r.syncedLyrics) && artist0) lists.push(...((await soft(() => search({ q: cleanTitle(t.title) }))) || []));
      rec = best(lists.filter(usable), t);
      if (!rec) plain = plain || best(lists.filter(r => r.plainLyrics), t);
    }
    const result = rec || plain || null;
    cache.set(t.key, result);
    return result;
  }
  return { find, search, byId, cleanTitle, score, clearCache: k => cache.delete(k) };
})();
