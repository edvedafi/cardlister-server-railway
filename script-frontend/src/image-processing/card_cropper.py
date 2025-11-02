#!/usr/bin/env python3
"""
card_cropper.py

Detects, crops, and rotates cards from images. Each card is saved as a separate image with a 10-pixel border in input/tmp. Debug images are saved in debug/.

Usage:
    python card_cropper.py image1.jpg image2.png ...

Returns JSON array of output image paths.
"""
import sys
import os
import cv2
import numpy as np
import json
from pathlib import Path

def ensure_dir(path):
    Path(path).mkdir(parents=True, exist_ok=True)

def find_cards(image, image_path=None):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    adapt = cv2.adaptiveThreshold(blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                 cv2.THRESH_BINARY, 11, 2)
    edged = cv2.Canny(adapt, 20, 100)

    # Find contours
    contours, _ = cv2.findContours(edged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if image_path:
        print(f"{image_path}: {len(contours)} contours found", file=sys.stderr)
        for cnt in contours:
            peri = cv2.arcLength(cnt, True)
            approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)
            area = cv2.contourArea(cnt)
            print(f"  area: {area:.0f} sides: {len(approx)}", file=sys.stderr)

    # Try to find 4-sided contours first
    card_contours = []
    for cnt in contours:
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)
        area = cv2.contourArea(cnt)
        if len(approx) == 4 and area > 5000:
            card_contours.append(approx)
    # If none found, take the largest contour above area threshold, approx to 4 points
    if not card_contours and contours:
        largest = max(contours, key=cv2.contourArea)
        area = cv2.contourArea(largest)
        if area > 5000:
            peri = cv2.arcLength(largest, True)
            approx = cv2.approxPolyDP(largest, 0.02 * peri, True)
            if len(approx) >= 4:
                # Force to 4 points for perspective transform
                # Take 4 points equally spaced around the contour
                step = max(1, len(approx)//4)
                forced = np.array([approx[i*step % len(approx)][0] for i in range(4)], dtype='float32')
                card_contours.append(forced)
    return card_contours, edged

def order_points(pts):
    # Orders points as: top-left, top-right, bottom-right, bottom-left
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect

def four_point_transform(image, pts, border=10):
    rect = order_points(pts)
    (tl, tr, br, bl) = rect

    widthA = np.linalg.norm(br - bl)
    widthB = np.linalg.norm(tr - tl)
    maxWidth = int(max(widthA, widthB))

    heightA = np.linalg.norm(tr - br)
    heightB = np.linalg.norm(tl - bl)
    maxHeight = int(max(heightA, heightB))

    dst = np.array([
        [border, border],
        [maxWidth + border - 1, border],
        [maxWidth + border - 1, maxHeight + border - 1],
        [border, maxHeight + border - 1]
    ], dtype="float32")

    M = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(image, M, (maxWidth + 2*border, maxHeight + 2*border))
    return warped

def process_image(image_path, debug_dir, output_dir, idx_offset=0):
    image = cv2.imread(image_path)
    if image is None:
        print(f"Warning: Could not read {image_path}", file=sys.stderr)
        return []
    basename = os.path.splitext(os.path.basename(image_path))[0]
    card_contours, edged = find_cards(image, image_path)

    # Save debug image with contours
    debug_img = image.copy()
    # Filter out empty contours to avoid OpenCV crash
    # Only keep contours with shape (N, 1, 2) and N > 0
    valid_contours = [c for c in card_contours if isinstance(c, np.ndarray) and c.ndim == 3 and c.shape[0] > 0 and c.shape[1] == 1 and c.shape[2] == 2]
    if len(valid_contours) > 0:
        cv2.drawContours(debug_img, valid_contours, -1, (0, 255, 0), 3)
    else:
        print(f"No card contour found for {image_path}", file=sys.stderr)
    debug_path = os.path.join(debug_dir, f"{basename}_debug.jpg")
    cv2.imwrite(debug_path, debug_img)

    # Save Canny edge image
    canny_path = os.path.join(debug_dir, f"{basename}_canny.jpg")
    cv2.imwrite(canny_path, edged)

    output_paths = []
    for i, contour in enumerate(card_contours):
        # Use minAreaRect for robust rectangle detection
        rect = cv2.minAreaRect(contour)
        box = cv2.boxPoints(rect)
        box = np.array(box, dtype="float32")

        # Compute margin: 8% of card size or at least 30px
        width = int(rect[1][0])
        height = int(rect[1][1])
        margin = max(int(0.08 * max(width, height)), 30)

        # Expand the box by the margin
        center = np.mean(box, axis=0)
        expanded_box = []
        for pt in box:
            vec = pt - center
            norm = np.linalg.norm(vec)
            if norm == 0:
                expanded_box.append(pt)
            else:
                expanded_box.append(center + vec * ((norm + margin) / norm))
        expanded_box = np.array(expanded_box, dtype="float32")

        # Order expanded_box points for perspective transform
        def order_box(pts):
            rect = np.zeros((4, 2), dtype="float32")
            s = pts.sum(axis=1)
            rect[0] = pts[np.argmin(s)]
            rect[2] = pts[np.argmax(s)]
            diff = np.diff(pts, axis=1)
            rect[1] = pts[np.argmin(diff)]
            rect[3] = pts[np.argmax(diff)]
            return rect
        rect_pts = order_box(expanded_box)

        # Compute width and height for the perspective transform
        (tl, tr, br, bl) = rect_pts
        widthA = np.linalg.norm(br - bl)
        widthB = np.linalg.norm(tr - tl)
        maxWidth = int(max(widthA, widthB))
        heightA = np.linalg.norm(tr - br)
        heightB = np.linalg.norm(tl - bl)
        maxHeight = int(max(heightA, heightB))

        dst = np.array([
            [0, 0],
            [maxWidth - 1, 0],
            [maxWidth - 1, maxHeight - 1],
            [0, maxHeight - 1]
        ], dtype="float32")
        M = cv2.getPerspectiveTransform(rect_pts, dst)
        warped = cv2.warpPerspective(image, M, (maxWidth, maxHeight))

        out_path = os.path.join(output_dir, f"{basename}_card{i+idx_offset+1}.jpg")
        cv2.imwrite(out_path, warped)
        output_paths.append(out_path)
    return output_paths

def main():
    if len(sys.argv) < 2:
        print("Usage: python card_cropper.py <image1> <image2> ...", file=sys.stderr)
        sys.exit(1)
    # Set project root as two directories up from this script's location
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
    debug_dir = os.path.join(project_root, "debug")
    output_dir = os.path.join(project_root, "input", "tmp")
    ensure_dir(debug_dir)
    ensure_dir(output_dir)
    output_paths = []
    idx_offset = 0
    for img_path in sys.argv[1:]:
        card_paths = process_image(img_path, debug_dir, output_dir, idx_offset)
        output_paths.extend(card_paths)
        idx_offset += len(card_paths)
    print(json.dumps(output_paths))

if __name__ == "__main__":
    main()
