import { describe, expect, it } from "vitest";

import { naturalRect, rectFromCorners, toNatural } from "../src/lib/annotate";

describe("toNatural", () => {
  it("scales a display point into natural screenshot pixels", () => {
    expect(
      toNatural({ dx: 50, dy: 25 }, { width: 100, height: 100 }, { width: 1000, height: 500 })
    ).toEqual({
      x: 500,
      y: 125
    });
  });

  it("maps the origin to the origin and rounds", () => {
    expect(
      toNatural({ dx: 0, dy: 0 }, { width: 100, height: 100 }, { width: 800, height: 600 })
    ).toEqual({
      x: 0,
      y: 0
    });
    expect(
      toNatural({ dx: 33, dy: 0 }, { width: 100, height: 100 }, { width: 1000, height: 1000 })
    ).toEqual({
      x: 330,
      y: 0
    });
  });

  it("falls back to the input when the box has not laid out", () => {
    expect(
      toNatural({ dx: 12.4, dy: 7.6 }, { width: 0, height: 0 }, { width: 100, height: 100 })
    ).toEqual({
      x: 12,
      y: 8
    });
  });
});

describe("rectFromCorners", () => {
  it("normalizes any corner order into a positive-size rect", () => {
    expect(rectFromCorners(10, 10, 30, 40)).toEqual({ x: 10, y: 10, width: 20, height: 30 });
    expect(rectFromCorners(30, 40, 10, 10)).toEqual({ x: 10, y: 10, width: 20, height: 30 });
    expect(rectFromCorners(30, 10, 10, 40)).toEqual({ x: 10, y: 10, width: 20, height: 30 });
  });

  it("yields a zero-size rect for a click without drag", () => {
    expect(rectFromCorners(5, 5, 5, 5)).toEqual({ x: 5, y: 5, width: 0, height: 0 });
  });
});

describe("naturalRect", () => {
  it("scales a display band into a natural-pixel region", () => {
    const band = { x: 10, y: 10, width: 40, height: 20 };
    const rect = naturalRect(band, { width: 100, height: 100 }, { width: 1000, height: 1000 });
    expect(rect).toEqual({ x: 100, y: 100, width: 400, height: 200 });
  });
});
