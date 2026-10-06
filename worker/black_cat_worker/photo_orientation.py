"""The saved clockwise quarter-turn, applied after the decoder's EXIF handling."""


def validate_rotation(value):
    if type(value) is not int or value not in (0, 90, 180, 270):
        raise ValueError("Photo rotation must be 0, 90, 180, or 270 degrees")
    return value


def rotate_cv_image(cv2, image, rotation):
    validate_rotation(rotation)
    if rotation == 0:
        return image
    turn = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}[rotation]
    return cv2.rotate(image, turn)
