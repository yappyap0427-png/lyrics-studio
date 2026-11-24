#!/usr/bin/env python3
"""Inline src/style.css and src/*.js into the single-file app: index.html."""
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "src"
JS_ORDER = ["util.js", "lrc.js", "palette.js", "lyrics.js", "sources.js", "renderer.js", "recorder.js", "app.js"]

html = (SRC / "template.html").read_text(encoding="utf-8")
css = (SRC / "style.css").read_text(encoding="utf-8")
js = "\n".join((SRC / f).read_text(encoding="utf-8") for f in JS_ORDER)
assert "</script" not in js.lower(), "JS must not contain a closing script tag"
out = html.replace("/*CSS*/", css).replace("/*JS*/", js)
(ROOT / "index.html").write_text(out, encoding="utf-8")
print(f"index.html  {len(out.encode('utf-8')) / 1024:.1f} KB")
