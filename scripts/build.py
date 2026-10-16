#!/usr/bin/env python3
"""Merge raw/catalog.json + raw/managers.json (from scripts/sync.mjs), raw/club.json (handles, roles, order)
and the expected-points files into site/data/fpl.json, the file the page loads."""
import json, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
raw = lambda name: json.loads((ROOT / 'raw' / name).read_text())

cat = raw('catalog.json')
managers = raw('managers.json')
P = {p[0]: p for p in cat['players']}

club = {c['id']: c for c in raw('club.json')}
for m in managers:
    c = club.get(m['id'])
    if c:
        m['handle'], m['role'] = c['handle'], c['role']
order = list(club)
managers.sort(key=lambda m: order.index(m['id']) if m['id'] in order else 999)

# Previous build keeps a manager on the page if FPL briefly fails for them.
out = ROOT / 'site/data/fpl.json'
if out.exists():
    old = {m['id']: m for m in json.loads(out.read_text()).get('managers', []) if not m.get('err')}
    managers = [old.get(m['id'], m) if m.get('err') else m for m in managers]

data = dict(cat)
data['managers'] = managers
data['xpSources'] = [json.loads((ROOT / 'raw' / f).read_text()) for f in ('xp_solio.json', 'xp.json') if (ROOT / 'raw' / f).exists()]

ids = [m['id'] for m in managers]
assert len(ids) == len(set(ids)), 'duplicate manager ids'
for m in managers:
    if m.get('err') or not m.get('picks'):
        continue
    els = [x[0] for x in m['picks']]
    assert len(els) == 15 and len(set(els)) == 15, f"bad picks for {m['id']}"
    missing = [e for e in els if e not in P]
    assert not missing, f"unknown players {missing} for {m['id']}"

out.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
print('wrote', out.relative_to(ROOT), out.stat().st_size, 'bytes;', len(managers), 'managers;',
      'errors:', [m['id'] for m in managers if m.get('err')] or 'none')
