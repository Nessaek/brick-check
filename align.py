#!/usr/bin/env python3
"""
align.py — align and color-normalize a "reference" build photo onto the
perspective of a "target" build photo, so the two can be compared fairly
even when they were shot at different angles or under different lighting.

Why this exists: LEGO mosaics/builds are covered in small, highly repetitive
studs. Generic feature matching (SIFT/ORB) gets confused by that repetition
and produces unreliable homographies. Instead, this script detects the
build's rectangular *frame* (a strong, unique quadrilateral) in both photos
and aligns on that.

Usage:
    python3 align.py <target_image_path> <image_to_warp_path>

Prints a single JSON object to stdout:
    {"success": true,  "image_base64": "...", "mime": "image/png"}
    {"success": false, "reason": "why it did not work"}

Any unexpected error is caught and reported the same way, so a calling
process can always safely fall back to using the original, unaligned photos.
"""
import sys
import json
import base64

import cv2
import numpy as np


def detect_frame_quad(img, min_area_ratio=0.2):
    """Find the largest quadrilateral in the image (the build's frame)."""
    h, w = img.shape[:2]
    scale = 1000.0 / w
    small = cv2.resize(img, (int(w * scale), int(h * scale)))

    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 30, 100)
    edges = cv2.dilate(edges, np.ones((5, 5), np.uint8), iterations=2)

    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:8]

    small_area = small.shape[0] * small.shape[1]
    for c in contours:
        area = cv2.contourArea(c)
        if area < min_area_ratio * small_area:
            continue
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4:
            pts = approx.reshape(-1, 2).astype(np.float32) / scale
            return pts
    return None


def order_points(pts):
    """Order 4 points as top-left, top-right, bottom-right, bottom-left."""
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).flatten()
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(d)]
    bl = pts[np.argmax(d)]
    return np.array([tl, tr, br, bl], dtype=np.float32)


def align_and_normalize(target_path, warp_path):
    target = cv2.imread(target_path)
    warp_img = cv2.imread(warp_path)
    if target is None or warp_img is None:
        return {"success": False, "reason": "Could not read one or both images."}

    h_t, w_t = target.shape[:2]

    quad_target = detect_frame_quad(target)
    quad_warp = detect_frame_quad(warp_img)
    if quad_target is None or quad_warp is None:
        return {"success": False, "reason": "Could not detect the build's frame/border in one of the photos."}

    quad_target = order_points(quad_target)
    quad_warp = order_points(quad_warp)

    H = cv2.getPerspectiveTransform(quad_warp, quad_target)
    warped = cv2.warpPerspective(warp_img, H, (w_t, h_t))

    valid = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY) > 0
    if valid.sum() < 0.15 * valid.size:
        return {"success": False, "reason": "Aligned overlap between the two photos was too small to be reliable."}

    try:
        from skimage.exposure import match_histograms
        normalized = warped.copy()
        for c in range(3):
            normalized[:, :, c] = match_histograms(warped[:, :, c], target[:, :, c], channel_axis=None)
        normalized[~valid] = target[~valid]
    except ImportError:
        # Color normalization is a nice-to-have; alignment alone is still useful without it.
        normalized = warped

    ok, buf = cv2.imencode(".png", normalized)
    if not ok:
        return {"success": False, "reason": "Failed to encode the aligned image."}

    return {
        "success": True,
        "image_base64": base64.b64encode(buf).decode("ascii"),
        "mime": "image/png",
    }


def main():
    if len(sys.argv) != 3:
        print(json.dumps({"success": False, "reason": "Expected 2 arguments: target_path warp_path"}))
        return
    try:
        result = align_and_normalize(sys.argv[1], sys.argv[2])
    except Exception as exc:  # noqa: BLE001 — always report cleanly, never crash the caller
        result = {"success": False, "reason": f"Unexpected error: {exc}"}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
