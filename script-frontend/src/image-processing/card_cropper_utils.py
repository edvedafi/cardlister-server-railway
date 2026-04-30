"""
card_cropper_utils.py

Shared rotation and contour-detection utilities used by both card_cropper_sam.py
and card_cropper_ollama.py.
"""

import cv2
import numpy as np


# ── Rotation helpers ─────────────────────────────────────────────────────────

def compute_rotation_angle(pts):
    """Compute the angle to rotate the image to align the card with the axes.

    OpenCV 4.x minAreaRect returns angle in (0, 90].  Convention:
      - If rect_w > rect_h → long side is "width" → for portrait card, rotate -(90-angle)
      - If rect_w <= rect_h → short side is "width" → rotate -angle

    Returns (rotation_angle_degrees, minAreaRect_result).
    """
    pts32 = np.array(pts, dtype=np.float32)
    rect = cv2.minAreaRect(pts32)
    rw, rh = rect[1]
    angle = rect[2]

    if rw == 0 or rh == 0:
        return 0.0, rect

    if rw > rh:
        rotation_angle = -(90.0 - angle)
    else:
        rotation_angle = -angle

    return rotation_angle, rect


def rotate_and_crop(image, pts, padding=0):
    """Rotate the image to align the card's edges with the axes, then crop.

    Args:
        image: Full-resolution BGR image (numpy array).
        pts: 4 corner points of the card in image coordinates (numpy float32).
        padding: Extra pixels to include beyond the detected card edge.

    Returns (cropped_image, rotated_pts_in_cropped_frame).
    """
    rotation_angle, _rect = compute_rotation_angle(pts)

    img_h, img_w = image.shape[:2]
    cx, cy = img_w / 2.0, img_h / 2.0

    if abs(rotation_angle) > 0.5:
        M = cv2.getRotationMatrix2D((cx, cy), rotation_angle, 1.0)

        # Expand canvas so no content is clipped after rotation
        cos_a = abs(M[0, 0])
        sin_a = abs(M[0, 1])
        new_w = int(img_h * sin_a + img_w * cos_a)
        new_h = int(img_h * cos_a + img_w * sin_a)
        M[0, 2] += (new_w - img_w) / 2.0
        M[1, 2] += (new_h - img_h) / 2.0

        rotated = cv2.warpAffine(
            image, M, (new_w, new_h),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REPLICATE,
        )

        pts_h = np.hstack([pts, np.ones((len(pts), 1), dtype=np.float32)])
        rotated_pts = (M @ pts_h.T).T
    else:
        rotated = image
        rotated_pts = pts

    # Axis-aligned bounding box crop
    xs, ys = rotated_pts[:, 0], rotated_pts[:, 1]
    x1 = int(max(0, xs.min() - padding))
    y1 = int(max(0, ys.min() - padding))
    x2 = int(min(rotated.shape[1], xs.max() + padding))
    y2 = int(min(rotated.shape[0], ys.max() + padding))

    return rotated[y1:y2, x1:x2], rotated_pts


# ── Contour fallback ─────────────────────────────────────────────────────────

def contour_fallback(image):
    """Fall back to classical edge detection to locate 4 card corners.

    CLAHE + Canny + morphological closing + minAreaRect on the largest
    qualifying contour.

    Returns numpy array (4, 2) in image coordinates, or None.
    """
    img_h, img_w = image.shape[:2]
    img_area = img_h * img_w
    min_area = 0.04 * img_area
    border_tol = 3

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    blur = cv2.GaussianBlur(enhanced, (5, 5), 0)
    edged = cv2.Canny(blur, 50, 150)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
    closed = cv2.morphologyEx(edged, cv2.MORPH_CLOSE, kernel)

    for binary in [
        closed,
        cv2.adaptiveThreshold(blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2),
    ]:
        contours, _ = cv2.findContours(binary.copy(), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        large = [c for c in contours if cv2.contourArea(c) > min_area]

        def is_border(cnt):
            x, y, w, h = cv2.boundingRect(cnt)
            return (x < border_tol and y < border_tol
                    and abs(x + w - img_w) < border_tol
                    and abs(y + h - img_h) < border_tol)

        large = [c for c in large if not is_border(c)]
        if large:
            c = max(large, key=cv2.contourArea)
            rect = cv2.minAreaRect(c)
            box = cv2.boxPoints(rect)
            return box.astype(np.float32)

    return None
