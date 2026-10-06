export const MAX_PHOTO_SCALE = 4;
export interface PhotoSize { width: number; height: number }
export interface PhotoPoint { x: number; y: number }
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

/** Geometry uses decoded image pixels; rotation affects the scrollable footprint. */
export function photoViewport(image: PhotoSize, frame: PhotoSize, rotation: number, zoom: number | null = null) {
  if (![image.width, image.height, frame.width, frame.height].every(value => Number.isFinite(value) && value > 0)
    || !Number.isFinite(rotation)) return null;
  const angle = rotation * Math.PI / 180;
  const cosine = Math.abs(Math.cos(angle)), sine = Math.abs(Math.sin(angle));
  const rotatedWidth = image.width * cosine + image.height * sine;
  const rotatedHeight = image.width * sine + image.height * cosine;
  if (!Number.isFinite(rotatedWidth) || !Number.isFinite(rotatedHeight)) return null;
  const fitScale = Math.min(1, frame.width / rotatedWidth, frame.height / rotatedHeight);
  const minimumScale = Math.min(.1, fitScale);
  const scale = zoom === null || !Number.isFinite(zoom) ? fitScale : clamp(zoom, minimumScale, MAX_PHOTO_SCALE);
  const width = rotatedWidth * scale, height = rotatedHeight * scale;
  if (![width, height, image.width * scale, image.height * scale].every(value => Number.isFinite(value) && value > 0)) return null;
  return { scale, fitScale, minimumScale, imageWidth: image.width * scale, imageHeight: image.height * scale,
    width, height, frameWidth: frame.width, frameHeight: frame.height,
    stageWidth: Math.max(frame.width, width), stageHeight: Math.max(frame.height, height),
    canPan: width > frame.width + 1 || height > frame.height + 1 };
}
export type PhotoViewport = NonNullable<ReturnType<typeof photoViewport>>;

/** Preserve a point in the rotated image when zoom or viewport size changes. */
export function photoViewCenter(view: PhotoViewport, left: number, top: number): PhotoPoint {
  return { x: clamp((left + view.frameWidth / 2 - (view.stageWidth - view.width) / 2) / view.width, 0, 1),
    y: clamp((top + view.frameHeight / 2 - (view.stageHeight - view.height) / 2) / view.height, 0, 1) };
}
export function photoViewScroll(view: PhotoViewport, point: PhotoPoint) {
  return { left: clamp((view.stageWidth - view.width) / 2 + point.x * view.width - view.frameWidth / 2, 0, view.stageWidth - view.frameWidth),
    top: clamp((view.stageHeight - view.height) / 2 + point.y * view.height - view.frameHeight / 2, 0, view.stageHeight - view.frameHeight) };
}
