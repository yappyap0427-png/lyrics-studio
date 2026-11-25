/* ---------- LRCLIB client (free synced-lyrics database, CORS enabled) ---------- */
const Lyrics = (() => {
  const API = 'https://lrclib.net/api';
  const CLIENT = 'LyricsStudio/1.1 (personal lyrics player)';
  const DISK_KEY = 'lyricsCache', DISK_MAX = 40, DISK_DAYS = 30, MISS_HOURS = 24;
  let headerOk = true, last = 0, blockedUntil = 0;
  const mem = new Map();
  const api = { timeoutMs: 10000 };

  async function call(path, signal) {
    const now = performance.now();
    if (now < blockedUntil) await sleep(blockedUntil - now);
    const wait = last + 300 - performance.now(); // one request at a time, gently spaced
    if (wait > 0) await sleep(wait);
    last = performance.now();
    let res;
    try {
      res = await fetchT(API + path, headerOk ? { headers: { 'Lrclib-Client': CLIENT }, signal } : { signal }, api.timeoutMs);
    } catch (e) {
      if (!headerOk || e.name !== 'TypeError') throw e; // timeouts and cancels are not header problems
      headerOk = false; // custom header refused by the CORS preflight: retry without it
      res = await fetchT(API + path, { signal }, api.timeoutMs);
    }
    if (res.status === 429) {
      const ra = parseFloat(res.headers.get('Retry-After')) || 10;
      blockedUntil = performance.now() + ra * 1000 * (1 + Math.random() * 0.3);
      throw new Error('RATE_LIMIT');
    }
    return res;
  }
  async function json(path, signal) {
    const r = await call(path, signal);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP_' + r.status);
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new Error('BAD_RESPONSE');
    return r.json();
  }
  const qs = o => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const get = (p, signal) => json('/get?' + qs(p), signal);
  const search = (p, signal) => json('/search?' + qs(p), signal).then(r => (Array.isArray(r) ? r : []));
  const byId = (id, signal) => json('/get/' + encodeURIComponent(id), signal);

  /* found lyrics survive a reload: a small least-recently-used store in localStorage */
  const slim = r => r && { id: r.id, trackName: r.trackName || r.name, artistName: r.artistName, albumName: r.albumName, duration: r.duration, instrumental: !!r.instrumental, syncedLyrics: r.syncedLyrics || null, plainLyrics: r.plainLyrics || null };
  function diskGet(key) {
    const all = Store.get(DISK_KEY, {});
    const hit = all[key];
    if (!hit) return undefined;
    const age = Date.now() - hit.at;
    if (age > (hit.r ? DISK_DAYS * 864e5 : MISS_HOURS * 36e5)) return undefined;
    return hit.r; // null = "looked recently, nothing there"
  }
  function diskPut(key, r) {
    const all = Store.get(DISK_KEY, {});
    all[key] = { r: slim(r), at: Date.now() };
    const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
    for (const k of keys.slice(DISK_MAX)) delete all[k];
    if (!Store.set(DISK_KEY, all)) { Store.del(DISK_KEY); Store.set(DISK_KEY, { [key]: all[key] }); }
  }
  function remember(key, r) { mem.set(key, r); diskPut(key, r); }
  function forget(key) {
    mem.delete(key);
    const all = Store.get(DISK_KEY, {});
    if (all[key]) { delete all[key]; Store.set(DISK_KEY, all); }
  }

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

  async function find(t, { force = false, signal } = {}) {
    const manual = Store.get('lyricsPick.' + t.key, null);
    if (manual === 'none') return { none: true };
    if (!force && mem.has(t.key)) return mem.get(t.key);
    if (!force) { const d = diskGet(t.key); if (d !== undefined && (!manual || (d && d.id === manual))) { mem.set(t.key, d); return d; } }
    if (manual) {
      try { const r = await byId(manual, signal); if (r) { remember(t.key, r); return r; } }
      catch (e) { if (e.message === 'RATE_LIMIT' || e.name === 'AbortError' || e.code === 'TIMEOUT') throw e; }
    }
    const artist0 = firstArtist(t.artist);
    const dur = t.duration ? Math.round(t.duration) : undefined;
    let rec = null, plain = null;
    const soft = async fn => {
      try { return await fn(); }
      catch (e) { if (e.message === 'RATE_LIMIT' || e.name === 'AbortError' || e.code === 'TIMEOUT') throw e; return null; }
    };

    if (t.title && artist0) {
      const r = await soft(() => get({ track_name: t.title, artist_name: artist0, album_name: t.album, duration: dur }, signal));
      if (usable(r)) rec = r; else if (r && r.plainLyrics) plain = r;
      const ct = cleanTitle(t.title);
      if (!rec && (ct !== t.title || t.album)) {
        const r2 = await soft(() => get({ track_name: ct, artist_name: artist0, duration: dur }, signal));
        if (usable(r2)) rec = r2; else if (r2 && r2.plainLyrics) plain = plain || r2;
      }
    }
    if (!rec && t.title) {
      const lists = [];
      lists.push(...((await soft(() => search({ track_name: cleanTitle(t.title), artist_name: artist0 || undefined }, signal))) || []));
      if (!lists.some(r => r.syncedLyrics)) lists.push(...((await soft(() => search({ q: [cleanTitle(t.title), artist0].filter(Boolean).join(' ') }, signal))) || []));
      if (!lists.some(r => r.syncedLyrics) && artist0) lists.push(...((await soft(() => search({ q: cleanTitle(t.title) }, signal))) || []));
      rec = best(lists.filter(usable), t);
      if (!rec) plain = plain || best(lists.filter(r => r.plainLyrics), t);
    }
    const result = rec || plain || null;
    remember(t.key, result);
    return result;
  }
  return Object.assign(api, { find, search, byId, cleanTitle, score, remember, clearCache: forget });
})();
