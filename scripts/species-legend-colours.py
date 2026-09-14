#!/usr/bin/env python3
"""species-legend-colours.py: the rendered colour of each scaled.circles class at a species-legend-probe.mjs view (B2, 2026-09-14).
Class comes from the tile's own data: each cell's `total` against the pinned style bounds (cells.json), never from colour.
A circle is sampled when its centre faces the camera, lies in the frame, is species-painted over the black globe, lies on land (the off
frame's basemap, analyse-compare.py's water rule), and no other cell's circle overlaps it (centre distance > sum of radii + 1 px, radius =
style width / 2 x screen px per tile px). Its colour is the median of `on` frame pixels within half its radius (at least 1 px) of the
centre. A class's colour is the median over its circles. dE76 and CIEDE2000 against given swatch colours.
Mode 'centre' (4th argument) relaxes the overlap rule: another circle may touch the sampled circle but must not reach its sampled centre
(centre distance > other radius + sample radius + 1 px). Each sampled circle also records its ground: the same pixels in the off frame.
Usage: python3 scripts/species-legend-colours.py <probe dir> <view> [swatches json] [lone|centre]   (the legend used 'centre')
Needs numpy and Pillow.
"""
import json, signal, sys
signal.signal(signal.SIGALRM, lambda *_: (sys.stderr.write("aborting: walltime guard\n"), sys.exit(2))); signal.alarm(600)
import numpy as np
from PIL import Image
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
per = {k: [] for k in range(5)}; ground = {k: [] for k in range(5)}; skipped = {'outside': 0, 'overlap': 0, 'notPainted': 0, 'water': 0}
for i, c in enumerate(cells):
    x, y, r = c['x'], c['y'], c['r']
    if not (r + 1 <= x < W - r - 1 and r + 1 <= y < H - r - 1): skipped['outside'] += 1; continue
    dist = np.hypot(xy[:, 0] - x, xy[:, 1] - y); dist[i] = np.inf
    s = max(1.0, 0.5 * r)
    if np.any(dist <= (rr + r + 1 if MODE == 'lone' else rr + s + 1)): skipped['overlap'] += 1; continue
    ix, iy = int(round(x)), int(round(y))
    if not species[iy, ix]: skipped['notPainted'] += 1; continue
    if not land[iy, ix]: skipped['water'] += 1; continue
    yy, xx = np.mgrid[int(np.floor(y - s)):int(np.ceil(y + s)) + 1, int(np.floor(x - s)):int(np.ceil(x + s)) + 1]
    m = np.hypot(xx - x, yy - y) <= s
    px = on[yy[m], xx[m]]
    per[c['cls']].append(np.median(px, axis=0)); ground[c['cls']].append(np.median(off[yy[m], xx[m]], axis=0))
def lab(rgb):
    c = np.asarray(rgb, dtype=np.float64) / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    X, Y, Z = (np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]) @ c) / np.array([0.95047, 1.0, 1.08883])
    f = lambda t: np.where(t > 216 / 24389, np.cbrt(t), (24389 / 27 * t + 16) / 116)
    fx, fy, fz = f(X), f(Y), f(Z)
    return np.array([116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)])
def de2000(l1, l2):
    L1, a1, b1 = l1; L2, a2, b2 = l2
    C1, C2 = np.hypot(a1, b1), np.hypot(a2, b2); Cb = (C1 + C2) / 2
    G = 0.5 * (1 - np.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p, h2p = np.degrees(np.arctan2(b1, a1p)) % 360, np.degrees(np.arctan2(b2, a2p)) % 360
    dLp, dCp = L2 - L1, C2p - C1p
    dh = h2p - h1p
    if C1p * C2p == 0: dh = 0
    elif dh > 180: dh -= 360
    elif dh < -180: dh += 360
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dh / 2))
    Lbp, Cbp = (L1 + L2) / 2, (C1p + C2p) / 2
    hbp = h1p + h2p
    if C1p * C2p != 0:
        hbp = (h1p + h2p + 360) / 2 if abs(h1p - h2p) > 180 else (h1p + h2p) / 2
    T = 1 - 0.17 * np.cos(np.radians(hbp - 30)) + 0.24 * np.cos(np.radians(2 * hbp)) + 0.32 * np.cos(np.radians(3 * hbp + 6)) - 0.20 * np.cos(np.radians(4 * hbp - 63))
    dth = 30 * np.exp(-(((hbp - 275) / 25) ** 2)); Rc = 2 * np.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
    Sl = 1 + 0.015 * (Lbp - 50) ** 2 / np.sqrt(20 + (Lbp - 50) ** 2); Sc = 1 + 0.045 * Cbp; Sh = 1 + 0.015 * Cbp * T
    Rt = -np.sin(np.radians(2 * dth)) * Rc
    return float(np.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh)))
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
