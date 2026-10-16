#!/usr/bin/env python3
"""Turn the Claude-artifact page (a body fragment) into a full HTML document for GitHub Pages.

  python3 tools/build_page.py src/page.html site/index.html

Adds the document head (charset, viewport, noindex, icons, link-preview tags), the reset the
artifact host normally supplies, and loads config.js + backend.js before the page's own script.
"""
import sys, re, pathlib

src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
page = src.read_text()
cut = page.index('<div class="sky">')
head, body = page[:cut].strip(), page[cut:]
head = re.sub(r'<meta name="claude:[^>]*>\s*', '', head)
title = re.search(r'<title>(.*?)</title>', head).group(1)
script_at = body.index('<script>')
body = body[:script_at] + '<script src="config.js"></script>\n<script src="backend.js"></script>\n' + body[script_at:]

SITE = 'https://zidanes-floor.github.io/vote/'
DESC = "Murder on Zidane's Floor — SKLW FPL team squad room: table, GW lineups with expected points, votes and head-to-heads for all 16 managers."
doc = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0B0920">
<meta name="description" content="{DESC}">
<meta property="og:type" content="website">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{DESC}">
<meta property="og:url" content="{SITE}">
<meta property="og:image" content="{SITE}assets/og.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" sizes="128x128" href="assets/icon-128.png">
<link rel="apple-touch-icon" href="assets/icon-180.png">
{head}
<style>
html {{ background: #0B0920; }}
body {{ margin: 0; min-height: 100vh; }}
img {{ max-width: 100%; }}
[hidden] {{ display: none !important; }}
</style>
</head>
<body>
{body.rstrip()}
</body>
</html>
'''
dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_text(doc)
print('wrote', dst, len(doc), 'bytes')
