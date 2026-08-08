#!/usr/bin/env python3
"""
Generates the synthetic framed-mosaic eval fixtures.

Alignment (preprocess/align.py) only engages when the build has a detectable
rectangular frame, which in practice means a flat framed mosaic. Every
photographed case in the suite is a loose 3D build, so without a mosaic case
the alignment and cell-diff code paths get no eval coverage at all.

These fixtures are generated rather than photographed so the suite carries no
third-party image licensing. Run this to regenerate them:

    preprocess/.venv/bin/python3 eval/make-mosaic-fixtures.py
"""
import os

import cv2
import numpy as np

CASES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cases')
SIZE = 1400
FRAME = 90          # margin outside the panel; its edge is the quad align.py locks onto
GRID = 14           # tiles per side
BASEPLATE = (128, 130, 132)

def scene():
    """A smooth little picture — sky gradient, sun, hill — that the mosaic
    quantises into tiles. Rendering a *picture* rather than a random palette
    matters: real brick mosaics depict something, so neighbouring tiles are
    usually similar. A random high-contrast checkerboard is a worst case for
    the cell diff, because a pixel or two of residual registration error then
    puts a huge colour delta on every tile boundary and buries the defect in
    the noise floor."""
    img = np.zeros((SIZE, SIZE, 3), np.float32)
    for y in range(SIZE):                                    # sky, light at the horizon
        blend = y / SIZE
        img[y, :] = np.array([210 - 60 * blend, 150 - 40 * blend, 90 - 20 * blend]) + 60 * blend
    cv2.circle(img, (int(SIZE * 0.7), int(SIZE * 0.28)), int(SIZE * 0.1), (80, 220, 250), -1)
    cv2.ellipse(img, (int(SIZE * 0.4), int(SIZE * 1.02)), (int(SIZE * 0.7), int(SIZE * 0.42)),
                0, 180, 360, (90, 160, 110), -1)
    return np.clip(img, 0, 255).astype(np.uint8)


def mosaic(missing=None):
    """Render the scene as framed brick tiles. `missing` is a (row, col) tile
    stripped back to bare baseplate, mimicking a brick never placed."""
    source = scene()
    img = np.full((SIZE, SIZE, 3), 235, np.uint8)
    # One thin outline exactly on the panel boundary. A *thick* frame band is
    # ambiguous: edge detection can lock onto its outer edge in one photo and
    # its inner edge in the other, offsetting the whole homography by the band
    # width and smearing large differences along every border.
    cv2.rectangle(img, (FRAME, FRAME), (SIZE - FRAME, SIZE - FRAME), (25, 25, 25), 3)

    span = (SIZE - 2 * FRAME) / GRID
    for row in range(GRID):
        for col in range(GRID):
            x0, y0 = int(FRAME + col * span), int(FRAME + row * span)
            x1, y1 = int(x0 + span * 0.94), int(y0 + span * 0.94)
            if missing == (row, col):
                cv2.rectangle(img, (x0, y0), (x1, y1), BASEPLATE, -1)
                cv2.rectangle(img, (x0, y0), (x1, y1), (95, 97, 99), 2)
                # Exposed studs, so the gap reads as bare baseplate.
                for sr in range(2):
                    for sc in range(2):
                        cx = int(x0 + (sc + 0.5) * (x1 - x0) / 2)
                        cy = int(y0 + (sr + 0.5) * (y1 - y0) / 2)
                        cv2.circle(img, (cx, cy), max(3, int(span * 0.09)), (150, 152, 154), -1)
                continue
            colour = tuple(int(v) for v in source[(y0 + y1) // 2, (x0 + x1) // 2])
            cv2.rectangle(img, (x0, y0), (x1, y1), colour, -1)
            cv2.circle(img, ((x0 + x1) // 2, (y0 + y1) // 2),
                       max(4, int(span * 0.18)), tuple(min(255, c + 30) for c in colour), -1)
    return img


def shot(img, skew, brightness):
    """Simulate photographing the mosaic from a different angle and light, so
    alignment has real work to do rather than comparing identical bitmaps."""
    src = np.float32([[0, 0], [SIZE, 0], [SIZE, SIZE], [0, SIZE]])
    warped = cv2.warpPerspective(img, cv2.getPerspectiveTransform(src, np.float32(skew)),
                                 (SIZE, SIZE), borderMode=cv2.BORDER_REPLICATE)
    return np.clip(warped.astype(np.float32) * brightness, 0, 255).astype(np.uint8)


# Deliberately gentle — about 1% of frame width, matching a hand-held reshoot
# of the same wall. Larger skews leave enough residual registration error to
# swamp the cell diff, which is a real limit of the technique, not a bug here.
STRAIGHT = [[0, 0], [SIZE, 0], [SIZE, SIZE], [0, SIZE]]
ANGLED = [[16, 9], [SIZE - 7, 19], [SIZE - 19, SIZE - 12], [9, SIZE - 5]]
ANGLED_OTHER = [[10, 15], [SIZE - 14, 7], [SIZE - 8, SIZE - 16], [17, SIZE - 9]]


def write(case, name, img):
    path = os.path.join(CASES, case, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cv2.imwrite(path, img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    print(f'  {case}/{name}')


complete = mosaic()
defective = mosaic(missing=(11, 11))  # bottom-right — the hardest area to spot

write('mosaic-missing-tile', 'build.jpg', shot(defective, ANGLED, 0.88))
write('mosaic-missing-tile', 'reference.jpg', shot(complete, STRAIGHT, 1.0))
write('mosaic-clean', 'build.jpg', shot(complete, ANGLED, 0.86))
write('mosaic-clean', 'reference.jpg', shot(complete, ANGLED_OTHER, 1.05))
print('fixtures written')
