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


MIN_GOOD_MATCHES = 25
MIN_INLIERS = 18
MIN_INLIER_RATIO = 0.15


def feature_homography(target, warp_img, work_w=1200):
    """Estimate a homography from SIFT correspondences.

    Frame detection is tried first and is better where it applies: a mosaic's
    repeated studs generate many plausible-but-wrong feature matches. But a
    free-standing build photographed on a table has no frame to find, which
    left alignment off for essentially every real photo. Feature matching is
    the only option there, so it runs as a fallback — with every homography it
    proposes validated before anything is allowed to use it.
    """
    def prep(img):
        h, w = img.shape[:2]
        s = work_w / float(w)
        small = cv2.resize(img, (work_w, max(1, int(h * s))), interpolation=cv2.INTER_AREA)
        return cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), s

    gray_dst, scale_dst = prep(target)
    gray_src, scale_src = prep(warp_img)

    sift = cv2.SIFT_create(nfeatures=6000)
    kp_src, des_src = sift.detectAndCompute(gray_src, None)
    kp_dst, des_dst = sift.detectAndCompute(gray_dst, None)
    if des_src is None or des_dst is None:
        return None, "Not enough visual detail in the photos to match them."

    knn = cv2.BFMatcher(cv2.NORM_L2).knnMatch(des_src, des_dst, k=2)
    # Lowe's ratio test. Studs repeat, so a feature that matches two places
    # about equally well is ambiguous and must be thrown away.
    good = [pair[0] for pair in knn
            if len(pair) == 2 and pair[0].distance < 0.75 * pair[1].distance]
    if len(good) < MIN_GOOD_MATCHES:
        return None, "The two photos have too little in common to align them."

    src = np.float32([kp_src[m.queryIdx].pt for m in good]).reshape(-1, 1, 2) / scale_src
    dst = np.float32([kp_dst[m.trainIdx].pt for m in good]).reshape(-1, 1, 2) / scale_dst

    H, mask = cv2.findHomography(src, dst, cv2.USAC_MAGSAC, 4.0,
                                 maxIters=20000, confidence=0.999)
    if H is None or mask is None:
        return None, "Could not fit a consistent transform between the photos."

    inliers = int(mask.sum())
    if inliers < MIN_INLIERS or inliers < MIN_INLIER_RATIO * len(good):
        return None, "Matches between the photos were too inconsistent to trust."
    return H, None


def homography_is_sane(H, src_shape, dst_shape):
    """Reject transforms that are numerically valid but physically absurd.

    RANSAC will happily return a homography that folds the reference into a
    sliver or turns it inside out. Warping by one produces a garbage overlay,
    and the cell diff downstream then reports the garbage as defects — worse
    than not aligning at all, because it looks authoritative.
    """
    h, w = src_shape[:2]
    corners = np.array([[0, 0], [w, 0], [w, h], [0, h]], np.float32).reshape(-1, 1, 2)
    try:
        proj = cv2.perspectiveTransform(corners, H).reshape(-1, 2)
    except cv2.error:
        return False
    if not np.all(np.isfinite(proj)):
        return False

    # Convex and consistently wound: a folded or mirrored quad fails here.
    # NumPy 2 dropped the 2-D form of np.cross, so do it by hand.
    def cross2(a, b):
        return a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]

    edges = np.roll(proj, -1, axis=0) - proj
    turns = cross2(edges, np.roll(edges, -1, axis=0))
    if not (np.all(turns > 0) or np.all(turns < 0)):
        return False

    nxt = np.roll(proj, -1, axis=0)
    area = 0.5 * abs(float((proj[:, 0] * nxt[:, 1] - nxt[:, 0] * proj[:, 1]).sum()))
    dst_area = float(dst_shape[0] * dst_shape[1])
    if not (0.15 * dst_area < area < 6.0 * dst_area):
        return False

    sides = np.linalg.norm(edges, axis=1)
    return sides.min() > 0.05 * sides.max()


def alignment_improves(target, warped, valid, min_zncc=0.45):
    """Confirm the warp actually made the photos more similar.

    The geometric checks above pass plenty of subtly-wrong homographies. This
    is the empirical backstop: correlate the overlap and keep the alignment
    only if the two photos genuinely agree.

    The 0.45 floor is measured, not guessed. A build shot on a granite worktop
    aligned at 0.27 by locking onto the *worktop's* speckle instead of the
    model, putting the subject in the wrong corner entirely — and that would
    have been handed to the model labelled "auto-aligned". Real alignments in
    the eval set score 0.59-0.99, so the gap is wide and the floor sits in it.
    """
    def gray_small(img):
        return cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (320, 240),
                          interpolation=cv2.INTER_AREA).astype(np.float32)

    def zncc(a, b, m):
        a, b = a[m], b[m]
        if a.size < 500:
            return -1.0
        a, b = a - a.mean(), b - b.mean()
        denom = float(np.sqrt((a * a).sum() * (b * b).sum()))
        return float((a * b).sum() / denom) if denom > 1e-6 else -1.0

    mask = cv2.resize(valid.astype(np.uint8), (320, 240), interpolation=cv2.INTER_NEAREST) > 0
    if mask.sum() < 500:
        return False, -1.0
    after = zncc(gray_small(target), gray_small(warped), mask)
    return after >= min_zncc, after


def align_and_normalize(target_path, warp_path):
    target = cv2.imread(target_path)
    warp_img = cv2.imread(warp_path)
    if target is None or warp_img is None:
        return {"success": False, "reason": "Could not read one or both images."}

    h_t, w_t = target.shape[:2]

    # Frame detection first — for a mosaic or a framed panel it is the more
    # reliable of the two, because repeated studs mislead feature matching.
    method = "frame"
    H = None
    quad_target = detect_frame_quad(target)
    quad_warp = detect_frame_quad(warp_img)
    if quad_target is not None and quad_warp is not None:
        H = cv2.getPerspectiveTransform(order_points(quad_warp), order_points(quad_target))
        if not homography_is_sane(H, warp_img.shape, target.shape):
            H = None

    if H is None:
        # No usable frame. This is the common case for a free-standing build
        # photographed on a table, so fall back to feature matching rather
        # than giving up and comparing two unaligned photos.
        method = "features"
        H, reason = feature_homography(target, warp_img)
        if H is None:
            return {"success": False, "reason": reason}
        if not homography_is_sane(H, warp_img.shape, target.shape):
            return {"success": False, "reason": "The transform between the photos was not physically plausible."}

    warped = cv2.warpPerspective(warp_img, H, (w_t, h_t))

    valid = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY) > 0
    if valid.sum() < 0.15 * valid.size:
        return {"success": False, "reason": "Aligned overlap between the two photos was too small to be reliable."}

    # Last gate, and the one that matters most: did the warp actually make the
    # two photos more similar? Everything downstream treats an alignment as
    # trustworthy, so a bad one is reported to the user as confident nonsense.
    improved, score = alignment_improves(target, warped, valid)
    if not improved:
        return {"success": False,
                "reason": f"Alignment did not make the photos measurably more similar (correlation {score:.2f})."}

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
        "method": method,
        "correlation": round(score, 3),
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

        # Adaptive threshold against the image's own noise floor, estimated
        # from the median and MAD of the covered cells.
        #
        # This used to be max(30, 2 * p95), which almost never fired: it asked
        # the single hottest cell to beat twice the 95th percentile, and a max
        # is rarely double its own p95. A known missing tile scored 43.9
        # against a gate of 48.9 and went unreported.
        #
        # Both terms below are needed. The MAD term alone flags noise in a
        # synthetic image whose MAD is near zero; the absolute floor alone
        # flags every busy real photo, where lighting and viewpoint push whole
        # regions past any fixed value. Defects have to clear both.
        covered_cells = dist[dist > 0]
        if covered_cells.size < 16:
            return []
        median = float(np.median(covered_cells))
        mad = float(np.median(np.abs(covered_cells - median)))
        threshold = max(25.0, median + 8.0 * mad)
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
