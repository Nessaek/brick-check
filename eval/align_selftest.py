#!/usr/bin/env python3
"""Fast, deterministic checks on the alignment + diff-region stage.

This exists because that stage failed silently for a long time. The diff
threshold was max(30, 2 * p95), which asks the hottest cell to beat twice the
95th percentile — a max is rarely double its own p95, so it almost never
fired. A known missing tile scored 43.9 against a gate of 48.9 and was never
reported. Nothing failed; the pipeline just quietly stopped contributing, and
the only symptom was the eval score drifting a few points lower.

The eval suite proper cannot catch that: it costs real money per run and
swings 4/9-7/9 on identical code, so a couple of lost points is invisible.
These checks call the image code directly, need no API key, and run in
seconds, so CI can assert the detector still fires on a known defect and
still stays quiet on a known-clean pair.

Usage:  python3 eval/align_selftest.py [cases_dir]
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'preprocess'))
sys.path.insert(0, '/app/preprocess')  # location inside the container image

import align  # noqa: E402

CASES = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cases')


def run(case):
    d = os.path.join(CASES, case)
    return align.align_and_normalize(os.path.join(d, 'build.jpg'), os.path.join(d, 'reference.jpg'))


def near(region, x, y, tol=15):
    return abs(region['x'] - x) <= tol and abs(region['y'] - y) <= tol


failures = []


def check(name, ok, detail):
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")
    if not ok:
        failures.append(name)


# A framed mosaic is the case frame detection handles, and it should align
# essentially perfectly. If this regresses, the geometry is broken.
r = run('mosaic-missing-tile')
check('mosaic aligns via frame detection',
      r.get('success') and r.get('method') == 'frame',
      f"success={r.get('success')} method={r.get('method')} zncc={r.get('correlation')}")

# The regression that motivated this file: a real missing tile must produce a
# candidate region, and one of them must land on it.
regions = r.get('regions', [])
check('missing tile produces diff regions', len(regions) > 0, f"{len(regions)} region(s)")
check('a diff region lands on the missing tile',
      any(near(g, 71, 84) for g in regions),
      f"flagged {[(g['x'], g['y']) for g in regions]}, expected one near (71, 84)")

# The opposite error is worse than a miss: crying defect on a correct build.
r = run('mosaic-clean')
check('identical build stays silent',
      r.get('success') and len(r.get('regions', [])) == 0,
      f"success={r.get('success')} regions={len(r.get('regions', []))}")

# A free-standing model on a table has no frame at all. Feature matching is
# the only route, and it has to clear the correlation floor.
r = run('plant-missing-foot')
check('frameless photo aligns via feature matching',
      r.get('success') and r.get('method') == 'features',
      f"success={r.get('success')} method={r.get('method')} zncc={r.get('correlation')}")

# ...but a moderate-quality alignment must not emit candidate regions. With
# hints from this pair the model reported nothing at all three times running;
# with them suppressed it found the defect. Wrong hints anchor the search.
check('moderate alignment emits no candidate regions',
      (r.get('correlation') or 0) < 0.80 and len(r.get('regions', [])) == 0,
      f"zncc={r.get('correlation')} regions={len(r.get('regions', []))}")

# A photo aligned against worktop speckle rather than the model scored 0.27
# and placed the subject in the wrong corner. It must stay rejected.
r = run('pig-lying-clean')
check('a bad match is rejected rather than trusted',
      not r.get('success'),
      f"success={r.get('success')} reason={r.get('reason', '')[:60]}")

print()
if failures:
    print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
    sys.exit(1)
print("all alignment self-checks passed")
