#!/usr/bin/env python3
"""species-legend-colours.py: the rendered colour of each scaled.circles class at a species-legend-probe.mjs view (B2, 2026-09-14).
Class comes from the tile's own data: each cell's `total` against the pinned style bounds (cells.json), never from colour.
A circle is sampled when its centre faces the camera, lies in the frame, is species-painted over the black globe, lies on land (the off
frame's basemap, where water is a pixel whose blue is more than 15 above its red and at least its green minus 10), and no other cell's circle overlaps it (centre distance > sum of radii + 1 px, radius =
style width / 2 x screen px per tile px). Its colour is the median of `on` frame pixels within half its radius (at least 1 px) of the
centre. A class's colour is the median over its circles. dE76 and CIEDE2000 against given swatch colours.
Mode 'centre' (4th argument) relaxes the overlap rule: another circle may touch the sampled circle but must not reach its sampled centre
(centre distance > other radius + sample radius + 1 px). Each sampled circle also records its ground: the same pixels in the off frame.
Mode 'single' samples every pixel of the circle (within its radius less 1 px) that no other circle reaches (beyond each other circle's
radius + 1 px) and that is species-painted land, when there are at least 4: the class's colour where it is the only circle, for classes
whose circles always overlap others (the <=10k and >10k circles at the global view with --years all).
Usage: python3 scripts/species-legend-colours.py <probe dir> <view> [swatches json] [lone|centre|single]   (the legend used 'centre' for the
three lowest classes, --years recent, and 'single' for the two highest, --years all)
Needs numpy and Pillow.
"""
import json, signal, sys
signal.signal(signal.SIGALRM, lambda *_: (sys.stderr.write("aborting: walltime guard\n"), sys.exit(2))); signal.alarm(600)
import numpy as np
from PIL import Image
from colour_diff import lab, de2000  # scripts/colour_diff.py, beside this file
d, view = sys.argv[1], sys.argv[2]
swatches = json.loads(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else {}
MODE = sys.argv[4] if len(sys.argv) > 4 else 'lone'
load = lambda n: np.asarray(Image.open(f'{d}/{view}__{n}.png').convert('RGB'), dtype=np.float64)
on, off, bon, boff = load('on'), load('off'), load('blackon'), load('blackoff')
H, W = on.shape[:2]
species = np.max(np.abs(bon - boff), axis=-1) > 10
ocean = (off[..., 2] > off[..., 0] + 15) & (off[..., 2] >= off[..., 1] - 10)
globe = np.max(np.abs(off - boff), axis=-1) > 6
land = globe & ~ocean
WIDTHS = [6, 7, 10, 16, 30]
cells = [c for c in json.load(open(f'{d}/{view}__cells.json')) if c['facing'] and c['x'] is not None and c['screenPxPerTilePx']]
for c in cells:
    c['r'] = WIDTHS[c['cls']] / 2 * c['screenPxPerTilePx']
xy = np.array([[c['x'], c['y']] for c in cells]); rr = np.array([c['r'] for c in cells])
per = {k: [] for k in range(5)}; ground = {k: [] for k in range(5)}; skipped = {'outside': 0, 'overlap': 0, 'notPainted': 0, 'water': 0, 'fewSinglePixels': 0}
for i, c in enumerate(cells):
    x, y, r = c['x'], c['y'], c['r']
    if not (r + 1 <= x < W - r - 1 and r + 1 <= y < H - r - 1): skipped['outside'] += 1; continue
    dist = np.hypot(xy[:, 0] - x, xy[:, 1] - y); dist[i] = np.inf
    s = max(1.0, 0.5 * r)
    if MODE != 'single' and np.any(dist <= (rr + r + 1 if MODE == 'lone' else rr + s + 1)): skipped['overlap'] += 1; continue
    ix, iy = int(round(x)), int(round(y))
    if not species[iy, ix]: skipped['notPainted'] += 1; continue
    if not land[iy, ix]: skipped['water'] += 1; continue
    if MODE == 'single':
        yy, xx = np.mgrid[int(np.floor(y - r)):int(np.ceil(y + r)) + 1, int(np.floor(x - r)):int(np.ceil(x + r)) + 1]
        m = np.hypot(xx - x, yy - y) <= r - 1
        for j in np.where(dist <= rr + r + 1)[0]:
            m &= np.hypot(xx - xy[j, 0], yy - xy[j, 1]) > rr[j] + 1
        m &= species[yy, xx] & land[yy, xx]
        if m.sum() < 4: skipped['fewSinglePixels'] += 1; continue
    else:
        yy, xx = np.mgrid[int(np.floor(y - s)):int(np.ceil(y + s)) + 1, int(np.floor(x - s)):int(np.ceil(x + s)) + 1]
        m = np.hypot(xx - x, yy - y) <= s
    px = on[yy[m], xx[m]]
    per[c['cls']].append(np.median(px, axis=0)); ground[c['cls']].append(np.median(off[yy[m], xx[m]], axis=0))
LABELS = ['<=10', '<=100', '<=1k', '<=10k', '>10k']
allcells = {k: sum(1 for c in cells if c['cls'] == k) for k in range(5)}
out = {'mode': MODE, 'view': view, 'dir': d, 'cellsFacing': len(cells), 'cellsPerClass': allcells, 'skipped': skipped, 'classes': []}
for k in range(5):
    row = {'class': LABELS[k], 'sampled': len(per[k])}
    if per[k]:
        arr = np.array(per[k]); med = np.median(arr, axis=0)
        row['medianRGB'] = [int(round(v)) for v in med]
        row['groundMedianRGB'] = [int(round(v)) for v in np.median(np.array(ground[k]), axis=0)]
        row['p25RGB'] = [int(round(v)) for v in np.percentile(arr, 25, axis=0)]; row['p75RGB'] = [int(round(v)) for v in np.percentile(arr, 75, axis=0)]
        for name, sw in swatches.items():
            row[f'dE76_{name}'] = round(float(np.linalg.norm(lab(med) - lab(sw[k]))), 1)
            row[f'dE2000_{name}'] = round(de2000(lab(med), lab(sw[k])), 1)
    out['classes'].append(row)
print(json.dumps(out))
