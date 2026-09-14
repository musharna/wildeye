#!/usr/bin/env python3
"""species-legend-fit.py: legend swatch colours for SPECIES_MAP_LEGEND (src/bio/gbif.js) from species-legend-probe.mjs runs, and how far
the committed colours are from them.

For each probe dir it runs species-legend-colours.py in 'centre' mode (classes from the tiles' own record counts). Per sampled class k:
T_k = (median rendered - (1 - opacity_k) * median ground) / opacity_k, the colour an opaque fill would render as. A shared model
T(v) = a * v + b_channel is fitted by least squares to the sampled (style fill, T_k) pairs and predicts the classes no run sampled:
(1 - opacity) * ground + opacity * T(fill), ground = median ground over all sampled circles. A sampled class's colour is its median over
the runs. It prints the fit, each class's colour, and CIEDE2000 / dE76 of the committed colour (read from src/bio/gbif.js) against each
run's median.

Run against a preview build (see scripts/species-legend-probe.mjs):
  python3 scripts/species-legend-fit.py <probe dir> [<probe dir> ...]
The committed colours came from three global runs on 2026-09-14: sampled classes #e4d9ac, #d5aa78, #cea878; predicted #be8770, #ab7272 from
a = 0.595, b = (88.6, 93.6, 93.8), ground (127, 145, 110), largest residual 23.6.
"""
import json, re, signal, subprocess, sys
from pathlib import Path
signal.signal(signal.SIGALRM, lambda *_: (sys.stderr.write("aborting: walltime guard\n"), sys.exit(2))); signal.alarm(1800)
import numpy as np
HERE = Path(__file__).resolve().parent
COLOURS = HERE / 'species-legend-colours.py'
dirs = sys.argv[1:]
if not dirs:
    sys.exit('usage: species-legend-fit.py <probe dir> [<probe dir> ...]')
FILLS = [(254, 217, 118), (253, 141, 60), (253, 141, 60), (240, 59, 32), (189, 0, 38)]
OPAC = [1.0, 0.8, 0.7, 0.6, 0.6]
LABELS = ['<=10', '<=100', '<=1k', '<=10k', '>10k']
gbif_js = (HERE.parent / 'src' / 'bio' / 'gbif.js').read_text()
committed = re.findall(r"color: '#([0-9a-f]{6})'", gbif_js)
if len(committed) != 5:
    sys.exit(f'expected 5 legend colours in src/bio/gbif.js, found {len(committed)}')
committed = [tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) for h in committed]
src = COLOURS.read_text()
exec(src[src.index('def lab('):src.index('LABELS = ')])  # lab() and de2000() from species-legend-colours.py
runs = {}
for d in dirs:
    out = subprocess.run([sys.executable, str(COLOURS), d, 'global', '', 'centre'], capture_output=True, text=True, timeout=900)
    if out.returncode != 0:
        sys.exit(f'species-legend-colours.py failed for {d}: {out.stderr[-500:]}')
    runs[d] = json.loads(out.stdout)
obs = {k: [] for k in range(5)}; grounds = []
for r in runs.values():
    for k, c in enumerate(r['classes']):
        if c['sampled']:
            obs[k].append((np.array(c['medianRGB'], float), np.array(c['groundMedianRGB'], float)))
            grounds.append(np.array(c['groundMedianRGB'], float))
if not grounds:
    sys.exit('no class was sampled in any run')
ground = np.median(np.array(grounds), axis=0)
A, y, pairs = [], [], []
for k in range(5):
    for med, g in obs[k]:
        T = (med - (1 - OPAC[k]) * g) / OPAC[k]
        pairs.append((np.array(FILLS[k], float), T))
        for ch in range(3):
            row = [FILLS[k][ch], 0, 0, 0]; row[1 + ch] = 1; A.append(row); y.append(T[ch])
sol, *_ = np.linalg.lstsq(np.array(A), np.array(y), rcond=None)
a, b = sol[0], sol[1:]
resid = max(float(np.abs((a * f + b) - T).max()) for f, T in pairs)
result = {'runs': dirs, 'ground': [round(float(v)) for v in ground], 'model': {'a': round(float(a), 3), 'b': [round(float(v), 1) for v in b], 'maxResidual': round(resid, 1)}, 'classes': []}
for k in range(5):
    if obs[k]:
        colour = [int(round(v)) for v in np.median(np.array([m for m, _ in obs[k]]), axis=0)]; source = 'sampled'
    else:
        colour = [int(round(v)) for v in (1 - OPAC[k]) * ground + OPAC[k] * np.clip(a * np.array(FILLS[k], float) + b, 0, 255)]; source = 'predicted'
    row = {'class': LABELS[k], 'source': source, 'colour': '#%02x%02x%02x' % tuple(colour), 'committed': '#%02x%02x%02x' % committed[k], 'perRun': []}
    for d, r in runs.items():
        c = r['classes'][k]
        if c['sampled']:
            row['perRun'].append({'dir': d, 'sampled': c['sampled'], 'median': c['medianRGB'], 'dE2000_committed': round(de2000(lab(c['medianRGB']), lab(committed[k])), 2), 'dE76_committed': round(float(np.linalg.norm(lab(c['medianRGB']) - lab(committed[k]))), 2)})
    result['classes'].append(row)
print(json.dumps(result, indent=1))
