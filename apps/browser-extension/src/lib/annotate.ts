/**
 * Pure coordinate math for the side-panel screenshot annotator. Kept free of
 * React / DOM so it can be unit-tested; the component supplies the live image
 * box + natural dimensions and renders the result.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Map a point in the displayed image's coordinate space (px relative to the
 * image box's top-left) to the screenshot's natural pixel space. Falls back to
 * the input when the box hasn't laid out yet (zero size).
 */
export function toNatural(
  display: { dx: number; dy: number },
  box: Size,
  natural: Size
): { x: number; y: number } {
  if (box.width === 0 || box.height === 0) {
    return { x: Math.round(display.dx), y: Math.round(display.dy) };
  }
  return {
    x: Math.round((display.dx / box.width) * natural.width),
    y: Math.round((display.dy / box.height) * natural.height)
  };
}

/** Normalize two corner points into a positive-size rect. */
export function rectFromCorners(ax: number, ay: number, bx: number, by: number): Rect {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay)
  };
}

/** Convert a display-space band into a natural-pixel region rect. */
export function naturalRect(band: Rect, box: Size, natural: Size): Rect {
  const tl = toNatural({ dx: band.x, dy: band.y }, box, natural);
  const br = toNatural({ dx: band.x + band.width, dy: band.y + band.height }, box, natural);
  return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
}
