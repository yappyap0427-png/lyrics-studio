// Unit tests for the pure parts of the app (placeholder text only). Run: node test/unit.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const FILES = ['util.js', 'lrc.js', 'palette.js', 'lyrics.js', 'sources.js', 'renderer.js', 'recorder.js'];
const code = FILES.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n;\n') +
  '\n;({ tokenize, mapRows, rowFill, charTimes, parseVideoTitle, YouTubeSource, Lyrics, Clock, LRC, Renderer, Env, fetchT, decodeText, Store, THEMES, THEME_ORDER, stripKaraoke })';

function memStorage(map = new Map()) {
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k), _map: map };
}
function load({ storage = memStorage(), fetchImpl } = {}) {
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, TextEncoder, TextDecoder, URL, URLSearchParams,
    performance: { now: () => Date.now() }, localStorage: storage, navigator: {}, document: {}, crypto: globalThis.crypto,
    location: { protocol: 'https:', hostname: 'example.github.io', origin: 'https://example.github.io', pathname: '/app/' },
    fetch: fetchImpl || (() => Promise.reject(new TypeError('no network in tests'))),
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  const api = vm.runInContext(code, ctx, { filename: 'bundle.js' });
  return { api, ctx };
}
const near = (a, b, eps = 1e-3, msg = '') => assert.ok(Math.abs(a - b) < eps, `${msg} ${a} != ${b}`);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const { api } = load();
const { tokenize, mapRows, rowFill, charTimes, parseVideoTitle, YouTubeSource, Lyrics, Clock, LRC, Renderer, decodeText, THEMES, THEME_ORDER, stripKaraoke } = api;

test('tokenize splits CJK per character and keeps Latin words with their spaces', () => {
  assert.deepStrictEqual(Array.from(tokenize('你好 world, 再見')), ['你', '好', ' ', 'world, ', '再', '見']);
});

function fakeRenderer() {
  const r = Object.create(Renderer.prototype);
  const width = s => Array.from(s).reduce((a, ch) => a + (/[　-鿿＀-￯]/.test(ch) ? 10 : 5), 0);
  r.x = { font: '10px test', measureText: s => ({ width: width(s) }) };
  r.mcache = new Map();
  return r;
}
test('wrap never starts a row with closing punctuation and balances rows', () => {
  const rows = Array.from(fakeRenderer().wrap('一二三四五六，七', 60), r => r.text);
  assert.deepStrictEqual(rows, ['一二三四', '五六，七']);
  for (const r of rows) assert.ok(!/^[，。！？、]/.test(r), r);
});
test('wrap breaks a word longer than the line into even pieces', () => {
  const rows = fakeRenderer().wrap('supercalifragilistic', 30);
  assert.strictEqual(rows.length, 4);
  for (const r of rows) assert.ok(r.w <= 30, r.text);
});
test('mapRows/rowFill follow the sung position across wrapped rows', () => {
  const rows = [{ chars: ['a', 'b'] }, { chars: ['c', 'd'] }];
  mapRows(rows, Array.from('ab cd'));
  assert.deepStrictEqual(Array.from(rows[0].map), [0, 1]);
  assert.deepStrictEqual(Array.from(rows[1].map), [3, 4]);
  near(rowFill(rows[0], 1.5), 1.5); near(rowFill(rows[1], 1.5), 0); near(rowFill(rows[1], 3.5), 0.5); near(rowFill(rows[0], 5), 2);
});
test('charTimes spreads a word across its characters', () => {
  const { st, en } = charTimes([{ text: 'ab', start: 0, end: 1 }, { text: 'c', start: 1, end: 1.5 }]);
  assert.deepStrictEqual(Array.from(st), [0, 0.5, 1]); assert.deepStrictEqual(Array.from(en), [0.5, 1, 1.5]);
});
test('parseVideoTitle handles common YouTube title shapes', () => {
  const p = (t, a) => { const r = parseVideoTitle(t, a); return { title: r.title, artist: r.artist }; };
  assert.deepStrictEqual(p('Some Singer - Night Drive (Official Music Video)', 'SomeSingerVEVO'), { title: 'Night Drive', artist: 'Some Singer' });
  assert.deepStrictEqual(p('晴空', '某歌手 Singer - Topic'), { title: '晴空', artist: '某歌手 Singer' });
  assert.deepStrictEqual(p('某歌手 Singer【晴空 Clear Sky】Official MV', 'Label Music'), { title: '晴空 Clear Sky', artist: '某歌手 Singer' });
  assert.deepStrictEqual(p('Song Name', 'Some Artist'), { title: 'Song Name', artist: 'Some Artist' });
});
test('karaoke and instrumental uploads give the original song name', () => {
  const p = (t, a) => JSON.parse(JSON.stringify(parseVideoTitle(t, a)));
  assert.deepStrictEqual(p('某歌手 - 晴空 (Karaoke 伴奏版)', 'KTV Channel'), { title: '晴空', artist: '某歌手', inst: true });
  assert.deepStrictEqual(p('某歌手 - 晴空 KTV伴奏版', 'KTV Channel'), { title: '晴空', artist: '某歌手', inst: true });
  assert.deepStrictEqual(p('Some Singer - Night Drive (Instrumental)', 'Backing Tracks'), { title: 'Night Drive', artist: 'Some Singer', inst: true });
  assert.deepStrictEqual(p('Some Singer - Night Drive [Off Vocal]', 'x'), { title: 'Night Drive', artist: 'Some Singer', inst: true });
  assert.deepStrictEqual(p('歌手A「夜の歌」カラオケ', 'x'), { title: '夜の歌', artist: '歌手A', inst: true });
  assert.deepStrictEqual(p('Some Singer - Night Drive - Karaoke Version', 'x'), { title: 'Night Drive', artist: 'Some Singer', inst: true });
  assert.strictEqual(p('Some Singer - Night Drive (Official Video)', 'Some Singer').inst, false);
  assert.strictEqual(stripKaraoke('初版'), '初版', 'a title that merely ends in 版 is kept');
  assert.strictEqual(stripKaraoke('Instinct'), 'Instinct', 'inst only as a whole word');
});
test('"Title - Artist" is turned round when the channel is the artist', () => {
  const p = (t, a) => JSON.parse(JSON.stringify(parseVideoTitle(t, a)));
  assert.deepStrictEqual(p('晴空 - 某歌手', '某歌手 Official'), { title: '晴空', artist: '某歌手', inst: false });
  assert.deepStrictEqual(p('某歌手 - 晴空', '某歌手'), { title: '晴空', artist: '某歌手', inst: false });
});
test('Lyrics matching: swapped names count for YouTube, instrumental records do not answer a karaoke video', () => {
  const rec = { trackName: '晴空', artistName: '某歌手', duration: 200, syncedLyrics: 'x' };
  const yt = { title: '某歌手', artist: '晴空', duration: 200, source: 'youtube' };
  const sp = { title: '某歌手', artist: '晴空', duration: 200, source: 'spotify' };
  assert.ok(Lyrics.score(rec, yt) >= 9, 'swapped YouTube names still match');
  assert.ok(Lyrics.score(rec, sp) < 9, 'Spotify names are exact, no swapping');
  assert.strictEqual(Lyrics.swapped(rec, yt), true);
  assert.strictEqual(Lyrics.swapped(rec, { title: '晴空', artist: '某歌手', source: 'youtube' }), false);
  assert.strictEqual(Lyrics.cleanTitle('Night Drive - Instrumental'), 'Night Drive');
  assert.strictEqual(Lyrics.isKaraoke({ title: 'Night Drive (Karaoke Version)' }), true);
  assert.strictEqual(Lyrics.isKaraoke({ title: 'Night Drive' }), false);
});
test('YouTubeSource.parseId reads every link style', () => {
  const id = 'abcdefghijk';
  for (const u of [`https://music.youtube.com/watch?v=${id}&list=RD`, `https://youtu.be/${id}?si=x`, `https://www.youtube.com/shorts/${id}`, id, `youtube.com/watch?v=${id}`]) assert.strictEqual(YouTubeSource.parseId(u), id, u);
  assert.strictEqual(YouTubeSource.parseId('https://example.com/foo'), null);
  assert.strictEqual(YouTubeSource.parseId('not a link'), null);
});
test('Lyrics.cleanTitle drops version noise', () => {
  assert.strictEqual(Lyrics.cleanTitle('Song - Remastered 2011'), 'Song');
  assert.strictEqual(Lyrics.cleanTitle('Song (feat. Someone)'), 'Song');
  assert.strictEqual(Lyrics.cleanTitle('Song (Live)'), 'Song');
  assert.strictEqual(Lyrics.cleanTitle('歌名 (電視劇片尾曲)'), '歌名');
  assert.strictEqual(Lyrics.cleanTitle('Normal Title'), 'Normal Title');
});
test('Lyrics.score prefers same title, artist and length', () => {
  const t = { title: 'Song', artist: 'Artist', duration: 200 };
  const exact = Lyrics.score({ trackName: 'Song', artistName: 'Artist', duration: 200, syncedLyrics: 'x' }, t);
  const longer = Lyrics.score({ trackName: 'Song', artistName: 'Artist', duration: 260, syncedLyrics: 'x' }, t);
  const other = Lyrics.score({ trackName: 'Song', artistName: 'Someone Else', duration: 200, syncedLyrics: 'x' }, t);
  assert.ok(exact > longer && exact > other, `${exact} ${longer} ${other}`);
});
test('Clock stays continuous on small corrections and play/pause, jumps only on seeks', () => {
  const c = new Clock();
  c.sync(10, true, 0, true);
  near(c.now(1000), 11);
  c.sync(10.7, true, 1000);           // report 0.3 s behind what was shown
  near(c.now(1000), 11, 1e-6, 'no jump at the report');
  near(c.now(3000), 12.7, 1e-3, 'converges to the report');
  c.sync(12.5, false, 2900);          // pause reported slightly behind
  near(c.now(2900), 12.6, 0.02, 'pause does not jump');
  near(c.now(5000), 12.5, 1e-6, 'settles on the paused position');
  c.sync(12.5, true, 5000);           // resume
  near(c.now(6000), 13.5, 1e-6);
  c.sync(50, true, 6000);             // seek
  near(c.now(6000), 50, 1e-6, 'seek jumps');
});
test('LRC.inspect tells synced, plain, empty and non-text files apart', () => {
  assert.strictEqual(LRC.inspect('[00:01.00]a line\n[00:02.00]another').kind, 'synced');
  assert.strictEqual(LRC.inspect('[ar:x]\nplain line\nsecond').kind, 'plain');
  assert.strictEqual(LRC.inspect('   \n ').kind, 'empty');
  assert.strictEqual(LRC.inspect('PK\u0003\u0004\u0000\u0000\u0000\u0000binary').kind, 'binary');
  assert.strictEqual(LRC.inspect('����ab��').kind, 'binary');
});
test('decodeText picks UTF-8, GBK or Big5 by content', () => {
  const words = '我的你是不了人';
  assert.strictEqual(decodeText(new TextEncoder().encode(words).buffer), words);
  const gbk = Uint8Array.from([0xCE, 0xD2, 0xB5, 0xC4, 0xC4, 0xE3, 0xCA, 0xC7, 0xB2, 0xBB, 0xC1, 0xCB, 0xC8, 0xCB]);
  assert.strictEqual(new TextDecoder('gb18030').decode(gbk), words, 'fixture bytes are GBK');
  assert.strictEqual(decodeText(gbk.buffer), words);
  const big5 = Uint8Array.from([0xA7, 0xDA, 0xAA, 0xBA, 0xA7, 0x41, 0xAC, 0x4F, 0xA4, 0xA3, 0xA4, 0x46, 0xA4, 0x48]);
  assert.strictEqual(new TextDecoder('big5').decode(big5), words, 'fixture bytes are Big5');
  assert.strictEqual(decodeText(big5.buffer), words);
});
test('every theme defines the fields the renderer reads', () => {
  const keys = ['label', 'desc', 'mode', 'font', 'weight', 'size', 'gapK', 'rowK', 'inactiveScale', 'inA', 'unA', 'glow', 'softBehind', 'dim', 'vignette', 'grain', 'grainFps', 'sat', 'blur', 'kenBurns', 'credit', 'ink'];
  for (const id of THEME_ORDER) for (const k of keys) assert.ok(k in THEMES[id], `${id}.${k}`);
});

async function asyncTests() {
  // fetchT: times out, and a caller's cancel is reported as a cancel (not a timeout)
  const hang = (url, opts) => new Promise((res, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  {
    const { api: a } = load({ fetchImpl: hang });
    await assert.rejects(a.fetchT('https://x/', {}, 30), e => e.code === 'TIMEOUT');
    const ctl = new AbortController();
    const p = a.fetchT('https://x/', { signal: ctl.signal }, 5000);
    ctl.abort();
    await assert.rejects(p, e => e.name === 'AbortError');
    console.log('ok  fetchT timeout and cancel');
  }
  // Lyrics.find: memory cache, then the localStorage cache survives a "reload"
  {
    const storage = memStorage();
    let calls = 0;
    const record = { id: 7, trackName: 'Song', artistName: 'Artist', albumName: 'A', duration: 200, instrumental: false, syncedLyrics: '[00:01.00]placeholder', plainLyrics: 'placeholder' };
    const fetchImpl = async () => { calls++; return { status: 200, ok: true, headers: { get: k => (k.toLowerCase() === 'content-type' ? 'application/json' : null) }, json: async () => record }; };
    const t = { key: 'sp:1', title: 'Song', artist: 'Artist', album: 'A', duration: 200 };
    const first = load({ storage, fetchImpl }).api;
    const r1 = await first.Lyrics.find(t);
    assert.strictEqual(r1.id, 7); const n1 = calls;
    await first.Lyrics.find(t); assert.strictEqual(calls, n1, 'memory cache');
    const second = load({ storage, fetchImpl }).api; // fresh page, same localStorage
    const r2 = await second.Lyrics.find(t);
    assert.strictEqual(r2.id, 7); assert.strictEqual(calls, n1, 'disk cache after reload');
    second.Store.set('lyricsPick.sp:1', 'none');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(await second.Lyrics.find(t))), { none: true });
    console.log('ok  Lyrics cache survives reload; "no lyrics" pin');
  }
  // a karaoke upload must not stop at LRCLIB's "instrumental" entry
  {
    const instRec = { id: 1, trackName: 'Night Drive', artistName: 'Some Singer', duration: 200, instrumental: true, syncedLyrics: null, plainLyrics: null };
    const orig = { id: 2, trackName: 'Night Drive', artistName: 'Some Singer', duration: 200, instrumental: false, syncedLyrics: '[00:01.00]placeholder', plainLyrics: 'placeholder' };
    const fetchImpl = async url => {
      const u = new URL(url);
      const body = u.pathname.endsWith('/get') ? instRec : u.pathname.endsWith('/search') ? [instRec, orig] : null;
      return { status: body ? 200 : 404, ok: !!body, headers: { get: () => 'application/json' }, json: async () => body || {} };
    };
    const a = load({ fetchImpl }).api;
    const r = await a.Lyrics.find({ key: 'yt:k1', title: 'Night Drive', artist: 'Some Singer', duration: 200, source: 'youtube', inst: true });
    assert.strictEqual(r && r.id, 2, 'karaoke video gets the original lyrics');
    const r2 = await a.Lyrics.find({ key: 'sp:k2', title: 'Night Drive', artist: 'Some Singer', duration: 200, source: 'spotify' });
    assert.strictEqual(r2 && r2.id, 1, 'the instrumental itself is still reported as instrumental');
    console.log('ok  karaoke video skips the instrumental record');
  }
  // Env: what each way of opening the page allows
  {
    const { api: a, ctx } = load();
    const cases = [[{ protocol: 'file:', hostname: '' }, 'file', false, false], [{ protocol: 'http:', hostname: 'localhost' }, 'localhost', false, true],
      [{ protocol: 'https:', hostname: 'x.github.io' }, 'https', true, true], [{ protocol: 'http:', hostname: '127.0.0.1' }, 'loopback', true, true]];
    for (const [loc, kind, sp, yt] of cases) {
      ctx.location = loc;
      assert.strictEqual(a.Env.kind(), kind); assert.strictEqual(a.Env.can('spotify'), sp, kind); assert.strictEqual(a.Env.can('youtube'), yt, kind);
    }
    console.log('ok  Env');
  }
}

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { fn(); console.log('ok  ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); }
  }
  try { await asyncTests(); } catch (e) { failed++; console.log('FAIL async: ' + (e.stack || e.message)); }
  console.log(failed ? `\n${failed} failed` : '\nunit tests: all passed');
  process.exit(failed ? 1 : 0);
})();
