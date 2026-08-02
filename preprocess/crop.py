#!/usr/bin/env python3
"""
crop.py — cut a zoomed square crop around a reported issue location, for
the second-pass verification step. A focused crop puts the model's whole
visual budget on the spot in question instead of the entire scene.

Usage:
    python3 crop.py <image_path> <x_pct> <y_pct> [--mark]

--mark draws a magenta circle at the exact (x, y) point, so the verifier
knows precisely which spot the first pass was talking about.

Prints a single JSON object to stdout:
    {"success": true, "image_base64": "...", "mime": "image/jpeg",
     "box": [x0_pct, y0_pct, x1_pct, y1_pct]}   # crop bounds in the full photo
    {"success": false, "reason": "why it did not work"}
"""
import sys
import json
import base64

import cv2


def crop_at(path, x_pct, y_pct, mark):
    img = cv2.imread(path)
    if img is None:
        return {"success": False, "reason": "Could not read the image."}
    h, w = img.shape[:2]

    side = int(min(h, w) * 0.34)
    cx, cy = int(w * x_pct / 100), int(h * y_pct / 100)
    x0 = max(0, min(w - side, cx - side // 2))
    y0 = max(0, min(h - side, cy - side // 2))
    crop = img[y0:y0 + side, x0:x0 + side].copy()

    if mark:
        radius = max(8, side // 14)
        thickness = max(2, side // 150)
        cv2.circle(crop, (cx - x0, cy - y0), radius, (255, 0, 255), thickness, cv2.LINE_AA)

    ok, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if not ok:
        return {"success": False, "reason": "Failed to encode the crop."}
    return {
        "success": True,
        "image_base64": base64.b64encode(buf).decode("ascii"),
        "mime": "image/jpeg",
        "box": [round(x0 / w * 100), round(y0 / h * 100), round((x0 + side) / w * 100), round((y0 + side) / h * 100)],
    }


def main():
    args = [a for a in sys.argv[1:] if a != "--mark"]
    mark = "--mark" in sys.argv
    if len(args) != 3:
        print(json.dumps({"success": False, "reason": "Expected: image_path x_pct y_pct [--mark]"}))
        return
    try:
        result = crop_at(args[0], float(args[1]), float(args[2]), mark)
    except Exception as exc:  # noqa: BLE001 — always report cleanly, never crash the caller
        result = {"success": False, "reason": f"Unexpected error: {exc}"}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
