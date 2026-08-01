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
        "regions": detect_diff_regions(target, normalized, valid),
    }


def _encode_crop(img, x0, y0, x1, y1):
    crop = img[y0:y1, x0:x1]
    side = max(crop.shape[:2])
    if side > 380:
        s = 380.0 / side
        crop = cv2.resize(crop, (max(1, int(crop.shape[1] * s)), max(1, int(crop.shape[0] * s))))
    ok, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return base64.b64encode(buf).decode("ascii") if ok else None


def detect_diff_regions(target, aligned, valid, max_regions=4):
    """Once the reference is warped onto the build photo, real differences
    (a missing/wrong brick) show up as localized pixel differences. Flag the
    strongest ones so the vision model can verify zoomed crops of each,
    instead of having to spot a tiny defect in a huge, busy image."""
    h, w = target.shape[:2]
    try:
        # Compare MEAN COLOR per brick-sized cell rather than per pixel:
        # residual 1-2px registration error puts strong per-pixel "ghosting"
        # on every stud edge, but averaging within a cell cancels it, while a
        # missing/wrong brick shifts its cell's mean color dramatically.
        det_w = 640
        s = det_w / w
        det_h = max(1, int(h * s))
        small_t = cv2.resize(target, (det_w, det_h), interpolation=cv2.INTER_AREA).astype(np.float32)
        small_a = cv2.resize(aligned, (det_w, det_h), interpolation=cv2.INTER_AREA).astype(np.float32)
        small_v = cv2.resize(valid.astype(np.uint8), (det_w, det_h), interpolation=cv2.INTER_NEAREST)

        cell = 16
        gh, gw = det_h // cell, det_w // cell
        if gh < 4 or gw < 4:
            return []

        def cell_means(img):
            return img[:gh * cell, :gw * cell].reshape(gh, cell, gw, cell, 3).mean(axis=(1, 3))

        dist = np.abs(cell_means(small_t) - cell_means(small_a)).max(axis=2)
        # Drop cells that aren't fully covered by the warped reference, and
        # the outermost ring of cells (frame/border artifacts).
        covered = small_v[:gh * cell, :gw * cell].reshape(gh, cell, gw, cell).min(axis=(1, 3))
        dist[covered == 0] = 0
        dist[0, :] = dist[-1, :] = 0
        dist[:, 0] = dist[:, -1] = 0

        # Adaptive threshold: a real defect stands far above the image's own
        # noise floor (p95 of cell distances).
        threshold = max(30.0, 2.0 * float(np.percentile(dist, 95)))
        hot = (dist > threshold).astype(np.uint8)
        if not hot.any():
            return []

        num, labels, stats, _ = cv2.connectedComponentsWithStats(hot, connectivity=8)
        candidates = []
        for lbl in range(1, num):
            cx, cy, cw_, ch_ = stats[lbl, cv2.CC_STAT_LEFT], stats[lbl, cv2.CC_STAT_TOP], stats[lbl, cv2.CC_STAT_WIDTH], stats[lbl, cv2.CC_STAT_HEIGHT]
            score = float(dist[cy:cy + ch_, cx:cx + cw_].max())
            candidates.append((score, cx, cy, cw_, ch_))
        candidates.sort(reverse=True)

        regions = []
        for _, cx, cy, cw_, ch_ in candidates[:max_regions]:
            # Map the cell-grid box back to full-resolution pixels.
            x = int(cx * cell / s)
            y = int(cy * cell / s)
            cw = int(cw_ * cell / s)
            ch = int(ch_ * cell / s)
            margin = int(0.9 * max(cw, ch)) + 12
            x0, y0 = max(0, x - margin), max(0, y - margin)
            x1, y1 = min(w, x + cw + margin), min(h, y + ch + margin)
            build_b64 = _encode_crop(target, x0, y0, x1, y1)
            ref_b64 = _encode_crop(aligned, x0, y0, x1, y1)
            if not build_b64 or not ref_b64:
                continue
            regions.append({
                "x": round((x + cw / 2) / w * 100),
                "y": round((y + ch / 2) / h * 100),
                "build_crop": build_b64,
                "ref_crop": ref_b64,
            })
        return regions
    except Exception:  # noqa: BLE001 — candidates are a bonus, never fail alignment over them
        return []


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
