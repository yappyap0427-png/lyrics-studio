/* ---------- colours taken from the album art ---------- */
const Palette = (() => {
  function fromImage(img, crop) {
    const s = 40;
    const { c, ctx } = makeCanvas(s, s);
    try {
      if (crop) ctx.drawImage(img, crop[0], crop[1], crop[2], crop[3], 0, 0, s, s);
      else ctx.drawImage(img, 0, 0, s, s);
    } catch (e) { return null; }
    let data;
    try { data = ctx.getImageData(0, 0, s, s).data; } catch (e) { return null; } // tainted
    const buckets = new Map();
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 200) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      sr += r; sg += g; sb += b; n++;
      const [h, sat, l] = rgbToHsl(r, g, b);
      const key = (Math.round(h / 15) % 24) + ':' + (sat > 0.22 ? 1 : 0) + ':' + Math.min(3, Math.floor(l * 4));
      let bk = buckets.get(key);
      if (!bk) buckets.set(key, (bk = { r: 0, g: 0, b: 0, n: 0 }));
      bk.r += r; bk.g += g; bk.b += b; bk.n++;
    }
    if (!n) return null;
    const cands = [...buckets.values()].map(b => {
      const rgb = [b.r / b.n, b.g / b.n, b.b / b.n];
      const [h, sat, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
      return { rgb, h, s: sat, l, n: b.n, score: b.n * (0.25 + sat * sat) * (l > 0.1 && l < 0.93 ? 1 : 0.2) };
    }).sort((a, b) => b.score - a.score);
    const picks = [];
    for (const cd of cands) {
      if (picks.every(p => hueDist(p.h, cd.h) > 28 || Math.abs(p.l - cd.l) > 0.3)) picks.push(cd);
      if (picks.length >= 4) break;
    }
    return build(picks, [sr / n, sg / n, sb / n]);
  }

  function build(picks, avg) {
    const main = picks[0] || { h: 260, s: 0.5, l: 0.5, rgb: [90, 70, 160] };
    const gray = picks.every(p => p.s < 0.15);
    const vivid = picks.slice().sort((a, b) => b.s * (1 - Math.abs(b.l - 0.55)) - a.s * (1 - Math.abs(a.l - 0.55)))[0] || main;
    const accent = gray ? [222, 228, 255] : hslToRgb(vivid.h, clamp(vivid.s + 0.15, 0.55, 0.9), 0.72);
    const dark = hslToRgb(gray ? 232 : main.h, gray ? 0.1 : Math.min(0.55, main.s), 0.1);
    const colors = picks.map(p => p.rgb);
    while (colors.length < 4) colors.push(hslToRgb((main.h + colors.length * 40) % 360, 0.5, 0.42));
    return { accent, dark, colors, avg };
  }

  /* no art (yet): a stable palette derived from the song name */
  function fromString(str) {
    const h = hashStr(String(str || 'x')) % 360;
    return {
      accent: hslToRgb((h + 20) % 360, 0.75, 0.74),
      dark: hslToRgb(h, 0.45, 0.09),
      colors: [hslToRgb(h, 0.62, 0.42), hslToRgb((h + 38) % 360, 0.58, 0.38), hslToRgb((h + 200) % 360, 0.52, 0.34), hslToRgb((h + 300) % 360, 0.58, 0.3)],
      avg: hslToRgb(h, 0.4, 0.3),
    };
  }
  return { fromImage, fromString };
})();
