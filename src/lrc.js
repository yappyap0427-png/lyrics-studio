/* ---------- LRC parsing + timeline ---------- */
const LRC = (() => {
  const TAG = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/;
  const META = /^\[([A-Za-z#][\w#-]*)\s*:([^\]]*)\]\s*$/;
  const WORD = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g;
  const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
  const LATIN = /[A-Za-z0-9À-ɏ]/;
  const ts = (m, s) => parseInt(m, 10) * 60 + parseFloat(String(s).replace(':', '.'));

  /* Enhanced LRC: "<00:12.00>word <00:12.40>word<00:12.90>" */
  function parseWords(s, lineTime) {
    WORD.lastIndex = 0;
    const marks = [];
    let m;
    while ((m = WORD.exec(s))) marks.push({ t: ts(m[1], m[2]), i: m.index, n: m[0].length });
    if (!marks.length) return null;
    const segs = [];
    const lead = s.slice(0, marks[0].i);
    if (lead) segs.push({ text: lead, start: lineTime });
    marks.forEach((mk, k) => {
      const from = mk.i + mk.n, to = k + 1 < marks.length ? marks[k + 1].i : s.length;
      segs.push({ text: s.slice(from, to), start: mk.t });
    });
    const words = [];
    for (let k = 0; k < segs.length; k++) {
      if (!segs[k].text) continue;
      const nxt = segs[k + 1];
      words.push({ text: segs[k].text, start: segs[k].start, end: nxt ? nxt.start : null });
    }
    if (!words.length) return null;
    words[0].text = words[0].text.replace(/^\s+/, '');
    words[words.length - 1].text = words[words.length - 1].text.replace(/\s+$/, '');
    const out = words.filter(w => w.text.length);
    return out.length ? out : null;
  }

  function parse(text) {
    const lines = [];
    const meta = {};
    let offset = 0;
    for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
      let s = raw.trim();
      if (!s) continue;
      if (!TAG.test(s)) {
        const mm = s.match(META);
        if (mm) {
          const k = mm[1].toLowerCase(), v = mm[2].trim();
          meta[k] = v;
          if (k === 'offset') { const n = parseFloat(v); if (isFinite(n)) offset = n / 1000; }
        }
        continue;
      }
      const times = [];
      let m;
      while ((m = s.match(TAG))) { times.push(ts(m[1], m[2])); s = s.slice(m[0].length); }
      const words = parseWords(s, times[0]);
      const body = (words ? words.map(w => w.text).join('') : s.replace(WORD, '')).trim();
      for (const t of times) {
        const d = t - times[0];
        lines.push({
          time: t,
          text: body,
          words: words ? words.map(w => ({ text: w.text, start: w.start + d, end: w.end == null ? null : w.end + d })) : null,
        });
      }
    }
    /* [offset:+500] means lyrics appear 0.5 s sooner */
    if (offset) {
      for (const l of lines) {
        l.time -= offset;
        if (l.words) for (const w of l.words) { w.start -= offset; if (w.end != null) w.end -= offset; }
      }
    }
    lines.sort((a, b) => a.time - b.time);
    return { lines, meta, hasWords: lines.some(l => l.words) };
  }

  /* rough singing time of a line, used to place interlude dots and pace the colour fill */
  function estimate(text) {
    let c = 0, l = 0;
    for (const ch of text) { if (CJK.test(ch)) c++; else if (LATIN.test(ch)) l++; }
    return Math.min(7.5, Math.max(1.6, c * 0.34 + l * 0.072));
  }

  function buildTimeline(parsed, duration) {
    const groups = [];
    for (const l of parsed.lines) {
      const g = groups[groups.length - 1];
      /* two lines on the same timestamp = original + translation */
      if (g && l.text && g.text && Math.abs(g.time - l.time) < 0.05) { g.subs.push(l.text); continue; }
      groups.push({ time: Math.max(0, l.time), text: l.text, words: l.words, subs: [] });
    }
    const out = [];
    const first = groups.find(g => g.text);
    if (!first) return out;
    if (first.time > 3) out.push({ type: 'gap', time: 0 });
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (!g.text) {
        if (out.length && out[out.length - 1].type !== 'gap') out.push({ type: 'gap', time: g.time });
        continue;
      }
      const e = { type: 'line', time: g.time, text: g.text, words: g.words, sub: g.subs.join('\n'), est: estimate(g.text) };
      out.push(e);
      const next = groups[i + 1];
      if (next && next.text) {
        const lastWord = g.words ? g.words[g.words.length - 1] : null;
        const sungTill = lastWord && lastWord.end != null ? lastWord.end : g.time + e.est;
        const gs = sungTill + 1.0;
        if (next.time - gs >= 5.5) out.push({ type: 'gap', time: gs, synthetic: true });
      }
    }
    for (let i = 0; i < out.length; i++) {
      const nx = out[i + 1];
      out[i].end = nx ? nx.time : Math.max(out[i].time + 4, duration || 0);
    }
    for (const e of out) {
      if (e.type === 'gap') { e.show = e.end - e.time >= 2.5; continue; }
      let fe;
      const lastWord = e.words ? e.words[e.words.length - 1] : null;
      if (lastWord) fe = lastWord.end != null ? lastWord.end : Math.min(e.end, e.time + e.est * 1.4);
      else fe = Math.min(e.end - 0.05, e.time + Math.max(1.1, e.est * 1.6));
      e.fillEnd = Math.max(e.time + 0.4, fe);
    }
    return out;
  }

  function activeIndex(E, t) {
    let lo = 0, hi = E.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (E[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /* what an imported file holds: synced lines, plain text, nothing, or not text at all */
  function inspect(text) {
    const s = String(text || '');
    if (!s.trim()) return { kind: 'empty', lines: 0 };
    const control = (s.match(/[\u0000-\u0008\u000E-\u001F]/g) || []).length;
    const broken = (s.match(/�/g) || []).length;
    if (control > 3 || broken > Math.max(3, s.length * 0.05)) return { kind: 'binary', lines: 0 };
    const synced = parse(s).lines.filter(l => l.text).length;
    if (synced) return { kind: 'synced', lines: synced };
    const plain = s.replace(/\r/g, '').split('\n').filter(l => l.trim() && !/^\s*\[[a-z#]+:.*\]\s*$/i.test(l)).length;
    return plain ? { kind: 'plain', lines: plain } : { kind: 'empty', lines: 0 };
  }

  return { parse, buildTimeline, activeIndex, estimate, inspect };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = LRC;
