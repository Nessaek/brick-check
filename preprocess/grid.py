#!/usr/bin/env python3
"""
grid.py — overlay a labeled coordinate grid onto a build photo.

Vision models locate defects well but estimate x/y percentages poorly —
pins often land 20+ points away from the defect on photos of 3D builds.
Giving the model a labeled grid to read coordinates off (rather than
estimate them) markedly improves pin placement.

Usage:
    python3 grid.py <image_path>

Prints a single JSON object to stdout:
    {"success": true,  "image_base64": "...", "mime": "image/jpeg"}
    {"success": false, "reason": "why it did not work"}
"""
import sys
import json
import base64

import cv2


def add_grid(path):
    img = cv2.imread(path)
    if img is None:
        return {"success": False, "reason": "Could not read the image."}
    h, w = img.shape[:2]

    # Semi-transparent magenta lines every 10% — visible against LEGO colors
    # without hiding what's underneath.
    color = (255, 0, 255)
    thickness = max(1, round(min(h, w) / 800))
    lines = img.copy()
    for p in range(10, 100, 10):
        x, y = int(w * p / 100), int(h * p / 100)
        cv2.line(lines, (x, 0), (x, h), color, thickness)
        cv2.line(lines, (0, y), (w, y), color, thickness)
    img = cv2.addWeighted(lines, 0.4, img, 0.6, 0)

    # Opaque percentage labels along the top and left edges, white-outlined
    # for legibility on any background.
    scale = max(0.45, min(h, w) / 1300)
    text_thickness = max(1, thickness)
    for p in range(10, 100, 10):
        x, y = int(w * p / 100), int(h * p / 100)
        for org in ((x + 5, int(scale * 26) + 5), (5, y - 7)):
            cv2.putText(img, str(p), org, cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), text_thickness + 2, cv2.LINE_AA)
            cv2.putText(img, str(p), org, cv2.FONT_HERSHEY_SIMPLEX, scale, (160, 0, 160), text_thickness, cv2.LINE_AA)

    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if not ok:
        return {"success": False, "reason": "Failed to encode the gridded image."}
    return {"success": True, "image_base64": base64.b64encode(buf).decode("ascii"), "mime": "image/jpeg"}


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"success": False, "reason": "Expected 1 argument: image_path"}))
        return
    try:
        result = add_grid(sys.argv[1])
    except Exception as exc:  # noqa: BLE001 — always report cleanly, never crash the caller
        result = {"success": False, "reason": f"Unexpected error: {exc}"}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
