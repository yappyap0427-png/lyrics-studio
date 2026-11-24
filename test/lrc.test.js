// Unit tests for the LRC parser (placeholder text only)
const assert = require('assert');
const LRC = require('../src/lrc.js');
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// 1. basic + metadata + multi-timestamps + colon fraction
{
  const p = LRC.parse(`[ar:Someone]\n[ti:Test]\n[00:01.50]line one\n[00:03.00][00:20.25]chorus line\n[00:05:40]colon frac\n\n[Chorus]\n`);
  assert.strictEqual(p.meta.ar, 'Someone');
  assert.deepStrictEqual(p.lines.map(l => l.text), ['line one', 'chorus line', 'colon frac', 'chorus line']);
  near(p.lines[0].time, 1.5); near(p.lines[1].time, 3); near(p.lines[2].time, 5.4); near(p.lines[3].time, 20.25);
}
// 2. offset: +500 ms means lyrics appear sooner
{
  const p = LRC.parse(`[offset:+500]\n[00:10.00]x`);
  near(p.lines[0].time, 9.5);
}
// 3. 3-digit fraction and minutes > 9
{
  const p = LRC.parse(`[12:01.123]late line`);
  near(p.lines[0].time, 721.123);
}
// 4. enhanced word timing
{
  const p = LRC.parse(`[00:10.00]<00:10.00>alpha <00:10.50>beta <00:11.20>gamma<00:12.00>`);
  const w = p.lines[0].words;
  assert.strictEqual(p.lines[0].text, 'alpha beta gamma');
  assert.strictEqual(w.length, 3);
  near(w[0].start, 10); near(w[0].end, 10.5); near(w[2].start, 11.2); near(w[2].end, 12);
  assert.ok(p.hasWords);
}
// 5. timeline: leading gap, bilingual merge, synthetic gap, explicit gap
{
  const p = LRC.parse(`[00:05.00]第一句歌詞\n[00:05.00]first line translation\n[00:08.00]第二句\n[00:30.00]第三句\n[00:34.00]\n[00:36.00]第四句`);
  const E = LRC.buildTimeline(p, 60);
  const types = E.map(e => e.type + ':' + (e.text || '').slice(0, 3));
  assert.strictEqual(E[0].type, 'gap'); // leading 0..5
  assert.strictEqual(E[1].text, '第一句歌詞');
  assert.strictEqual(E[1].sub, 'first line translation');
  // after 第二句 (8s) comes a long pause until 30s -> synthetic gap
  const syn = E.find(e => e.synthetic);
  assert.ok(syn && syn.time > 8 && syn.time < 30, 'synthetic gap: ' + JSON.stringify(types));
  // explicit empty line at 34 → gap of 2s → not shown
  const g34 = E.find(e => e.type === 'gap' && Math.abs(e.time - 34) < 1e-6);
  assert.ok(g34 && g34.show === false);
  // ends chain
  for (let i = 0; i < E.length - 1; i++) near(E[i].end, E[i + 1].time);
  assert.strictEqual(E[E.length - 1].end, 60);
  // fillEnd within the line
  for (const e of E) if (e.type === 'line') assert.ok(e.fillEnd > e.time && e.fillEnd <= e.end + 1e-9);
}
// 6. activeIndex
{
  const E = [{ time: 0 }, { time: 2 }, { time: 5 }];
  assert.strictEqual(LRC.activeIndex(E, -1), -1);
  assert.strictEqual(LRC.activeIndex(E, 0), 0);
  assert.strictEqual(LRC.activeIndex(E, 4.99), 1);
  assert.strictEqual(LRC.activeIndex(E, 99), 2);
}
// 7. garbage / plain text produces no lines
{
  const p = LRC.parse('just some words\nwithout timestamps');
  assert.strictEqual(p.lines.length, 0);
  assert.strictEqual(LRC.buildTimeline(p, 100).length, 0);
}
console.log('lrc tests: all passed');
