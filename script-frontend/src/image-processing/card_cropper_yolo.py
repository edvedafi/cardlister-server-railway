import cv2
import os
import json
import sys
import numpy as np
from pathlib import Path
import logging

# Suppress Ultralytics logging
logging.getLogger('ultralytics').setLevel(logging.ERROR)
# Suppress Python warnings
import warnings
warnings.filterwarnings("ignore")

def ensure_dir(path):
    """Ensure output directory exists"""
    Path(path).mkdir(parents=True, exist_ok=True)

def order_points(pts):
    # Order points in the order: top-left, top-right, bottom-right, bottom-left
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect

def four_point_transform(image, pts):
    rect = order_points(pts)
    (tl, tr, br, bl) = rect
    widthA = np.linalg.norm(br - bl)
    widthB = np.linalg.norm(tr - tl)
    maxWidth = max(int(widthA), int(widthB))
    heightA = np.linalg.norm(tr - br)
    heightB = np.linalg.norm(tl - bl)
    maxHeight = max(int(heightA), int(heightB))
    dst = np.array([
        [0, 0],
        [maxWidth - 1, 0],
        [maxWidth - 1, maxHeight - 1],
        [0, maxHeight - 1]], dtype="float32")
    M = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(image, M, (maxWidth, maxHeight))
    return warped

def detect_and_crop_cards(image_paths, output_dir):
    """Detect the largest rectangular card in each image and save a perspective-corrected crop"""
    results = []
    ensure_dir(output_dir)
    for idx, img_path in enumerate(image_paths):
        try:
            img = cv2.imread(img_path)
            if img is None:
                raise ValueError(f"Could not read image: {img_path}")
            # Prepare unique output filename for each input
            img_stem = Path(img_path).stem
            out_path = os.path.join(output_dir, f"{img_stem}_cropped.jpg")
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            # Apply CLAHE for better contrast
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            enhanced = clahe.apply(gray)
            blur = cv2.GaussianBlur(enhanced, (5, 5), 0)

            # Try both Canny and adaptive threshold
            edged = cv2.Canny(blur, 50, 150)
            # Morphological closing to connect card edges
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
            closed = cv2.morphologyEx(edged, cv2.MORPH_CLOSE, kernel)
            thresh = cv2.adaptiveThreshold(blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2)

            found = False
            card_contour = None
            img_h, img_w = img.shape[:2]
            img_area = img_h * img_w
            CARD_ASPECT = 2.5/3.5  # ~0.714, standard trading card
            BEST_ASPECT_TOL = 0.12  # Acceptable aspect ratio deviation
            MIN_CARD_AREA = 0.01 * img_area  # Lower temporarily for debugging
            MAX_CARD_AREA = 0.95 * img_area  # Card shouldn't be almost the whole image
            best_score = float('inf')
            best_contour = None
            for binary in [closed, thresh]:
                contours, _ = cv2.findContours(binary.copy(), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                debug_img = img.copy()
                print(f"[{Path(img_path).name}] {('Canny' if np.array_equal(binary, edged) else 'Thresh')} found {len(contours)} contours.", file=sys.stderr)
                img_h, img_w = img.shape[:2]
                border_tol = 2  # pixels
                largest_4pt = None
                largest_area = 0
                for c in contours:
                    peri = cv2.arcLength(c, True)
                    approx = cv2.approxPolyDP(c, 0.02 * peri, True)
                    area = cv2.contourArea(approx)
                    color = tuple(np.random.randint(0, 255, 3).tolist())
                    # Draw all contours for debugging
                    cv2.drawContours(debug_img, [approx], -1, color, 2)
                    if len(approx) == 4 and MIN_CARD_AREA < area < MAX_CARD_AREA:
                        pts = approx.reshape(4, 2)
                        # Ignore image border contour
                        if np.all([
                            (abs(pt[0]) < border_tol or abs(pt[0] - img_w) < border_tol or
                             abs(pt[1]) < border_tol or abs(pt[1] - img_h) < border_tol)
                            for pt in pts
                        ]):
                            continue
                        if area > largest_area:
                            largest_area = area
                            largest_4pt = approx
                # --- After all contour checks, try minAreaRect on largest valid contour ---
                if not found and len(contours) > 0:
                    img_area = img.shape[0] * img.shape[1]
                    min_area = 0.10 * img_area  # 10% of image
                    large_contours = [c for c in contours if cv2.contourArea(c) > min_area]
                    # Exclude image border by checking bounding rect
                    def is_border(cnt):
                        x, y, w, h = cv2.boundingRect(cnt)
                        return (x < border_tol and y < border_tol and
                                abs(x + w - img_w) < border_tol and abs(y + h - img_h) < border_tol)
                    large_contours = [c for c in large_contours if not is_border(c)]
                    if large_contours:
                        c = max(large_contours, key=cv2.contourArea)
                        rect = cv2.minAreaRect(c)
                        box = cv2.boxPoints(rect)
                        box = np.int0(box)
                        card_contour = box
                        found = True
                        print(f"[{Path(img_path).name}] Fallback to minAreaRect (large contour, post-closing).", file=sys.stderr)
                        # Draw final rectangle in red for debug
                        cv2.drawContours(debug_img, [box], -1, (0,0,255), 4)
                    else:
                        print(f"[{Path(img_path).name}] No contour large enough for minAreaRect fallback (post-closing).", file=sys.stderr)
                # --- Hough line fallback if all else fails ---
                if not found:
                    # Use Hough line detection to find straight edges
                    # Only on the closed edge map
                    hough_img = closed.copy()
                    lines = cv2.HoughLinesP(hough_img, 1, np.pi/180, threshold=100, minLineLength=img_w//4, maxLineGap=20)
                    if lines is not None and len(lines) >= 4:
                        # Convert lines to endpoints
                        endpoints = []
                        for line in lines:
                            x1, y1, x2, y2 = line[0]
                            endpoints.append(((x1, y1), (x2, y2)))
                        # Cluster lines by angle to find 2 sets of parallel lines (sides)
                        def angle(p1, p2):
                            return np.arctan2(p2[1]-p1[1], p2[0]-p1[0])
                        angles = [angle(*ep) for ep in endpoints]
                        # Group by near-horizontal and near-vertical
                        horiz = [ep for ep, a in zip(endpoints, angles) if abs(np.sin(a)) < 0.5]
                        vert = [ep for ep, a in zip(endpoints, angles) if abs(np.cos(a)) < 0.5]
                        # Take the 2 longest from each group
                        horiz = sorted(horiz, key=lambda ep: np.linalg.norm(np.subtract(ep[0], ep[1])), reverse=True)[:2]
                        vert = sorted(vert, key=lambda ep: np.linalg.norm(np.subtract(ep[0], ep[1])), reverse=True)[:2]
                        if len(horiz) == 2 and len(vert) == 2:
                            # Find intersections to get corners
                            def line_to_coeffs(p1, p2):
                                A = p2[1] - p1[1]
                                B = p1[0] - p2[0]
                                C = A * p1[0] + B * p1[1]
                                return A, B, -C
                            def intersection(l1, l2):
                                L1 = line_to_coeffs(*l1)
                                L2 = line_to_coeffs(*l2)
                                D = L1[0] * L2[1] - L2[0] * L1[1]
                                if D == 0:
                                    return None
                                Dx = L1[2] * L2[1] - L2[2] * L1[1]
                                Dy = L1[0] * L2[2] - L2[0] * L1[2]
                                x = Dx / D
                                y = Dy / D
                                return int(x), int(y)
                            corners = [
                                intersection(horiz[0], vert[0]),
                                intersection(horiz[0], vert[1]),
                                intersection(horiz[1], vert[0]),
                                intersection(horiz[1], vert[1]),
                            ]
                            if all(c is not None for c in corners):
                                card_contour = np.array(corners)
                                found = True
                                print(f"[{Path(img_path).name}] Fallback to Hough lines rectangle.", file=sys.stderr)
                                # Draw in blue for debug
                                cv2.polylines(debug_img, [card_contour.reshape((-1,1,2))], isClosed=True, color=(255,0,0), thickness=4)

                # Save debug image for this binary
                debug_dir = os.path.join(os.path.dirname(output_dir), 'debug')
                Path(debug_dir).mkdir(parents=True, exist_ok=True)
                debug_path = os.path.join(debug_dir, f"debug_{Path(img_path).stem}_{'canny' if np.array_equal(binary, edged) else 'thresh'}.jpg")
                cv2.imwrite(debug_path, debug_img)
                if largest_4pt is not None:
                    card_contour = largest_4pt
                    found = True
                    break
                # Fallback: try largest convex hull with 4 points
                if not found and len(contours) > 0:
                    c = max(contours, key=cv2.contourArea)
                    hull = cv2.convexHull(c)
                    peri = cv2.arcLength(hull, True)
                    approx = cv2.approxPolyDP(hull, 0.02 * peri, True)
                    if len(approx) == 4:
                        card_contour = approx
                        found = True
                    elif len(approx) > 4:
                        card_contour = approx[:4]
                        found = True
                # Final fallback: use minAreaRect for the largest plausible contour
                if not found and len(contours) > 0:
                    img_area = img.shape[0] * img.shape[1]
                    min_area = 0.10 * img_area  # 10% of image
                    large_contours = [c for c in contours if cv2.contourArea(c) > min_area]
                    if large_contours:
                        c = max(large_contours, key=cv2.contourArea)
                        rect = cv2.minAreaRect(c)
                        box = cv2.boxPoints(rect)
                        box = np.int0(box)
                        card_contour = box
                        found = True
                        print(f"[{Path(img_path).name}] Fallback to minAreaRect (large contour).", file=sys.stderr)
                    else:
                        print(f"[{Path(img_path).name}] No contour large enough for minAreaRect fallback.", file=sys.stderr)



            # If the best contour is nearly the image border, shrink by 3% and try again
            if found and card_contour is not None:
                card_pts = card_contour.reshape(4, 2)
                # Check if all points are within 2% of the image border
                border_margin = 0.02
                close_to_border = np.all([
                    (0 <= pt[0] <= border_margin*img_w or (1-border_margin)*img_w <= pt[0] <= img_w) and
                    (0 <= pt[1] <= border_margin*img_h or (1-border_margin)*img_h <= pt[1] <= img_h)
                    for pt in card_pts
                ])
                if close_to_border:
                    # Shrink crop by 3% on each side
                    shrink = 0.03
                    x0, y0 = int(shrink*img_w), int(shrink*img_h)
                    x1, y1 = int((1-shrink)*img_w), int((1-shrink)*img_h)
                    card_pts = np.array([
                        [x0, y0], [x1, y0], [x1, y1], [x0, y1]
                    ], dtype="float32")
                    card_contour = card_pts.reshape(4, 1, 2)

            # Fallback: use the largest contour and approximate to 4 points
            if not found and len(contours) > 0:
                c = max(contours, key=cv2.contourArea)
                peri = cv2.arcLength(c, True)
                approx = cv2.approxPolyDP(c, 0.02 * peri, True)
                if len(approx) >= 4:
                    card_contour = approx[:4]
                    found = True
            if not found or card_contour is None or len(card_contour) != 4:
                raise ValueError("Could not find card contour.")
            warped = four_point_transform(img, card_contour.reshape(4, 2))
            base_name = Path(img_path).stem
            output_path = f"{output_dir}/{base_name}_card.jpg"
            cv2.imwrite(output_path, warped)
            card_boxes = [{
                'original_path': img_path,
                'cropped_path': output_path,
                'coordinates': card_contour.reshape(4, 2).tolist(),
                'confidence': 1.0
            }]
            results.append({
                'success': True,
                'image_path': img_path,
                'cards': card_boxes
            })
        except Exception as e:
            results.append({
                'success': False,
                'image_path': img_path,
                'error': str(e)
            })
    return results

if __name__ == '__main__':
    # Accept image paths as command-line arguments
    if len(sys.argv) < 3:
        print("Usage: python card_cropper_yolo.py <output_dir> <image1> <image2> ...", file=sys.stderr)
        sys.exit(1)
    output_dir = sys.argv[1]
    image_paths = sys.argv[2:]
    # Redirect stdout to stderr for everything except the final JSON output
    import contextlib
    import io
    fake_stdout = io.StringIO()
    with contextlib.redirect_stdout(sys.stderr):
        results = detect_and_crop_cards(image_paths, output_dir)
    print(json.dumps(results))