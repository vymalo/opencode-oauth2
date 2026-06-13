import { describe, expect, it } from "vitest";

import {
  type CaptureLimits,
  planFullPageCapture,
  uint8ToBase64
} from "../src/background/full-page";

const LIMITS: CaptureLimits = { maxSlices: 20, maxDeviceHeight: 16_384 };

function metrics(fullH: number, viewportH = 800, viewportW = 1280, dpr = 1) {
  return { scrollX: 0, scrollY: 0, viewportW, viewportH, fullH, dpr };
}

describe("planFullPageCapture", () => {
  it("uses a single slice for a page that fits the viewport", () => {
    const plan = planFullPageCapture(metrics(600), LIMITS);
    expect(plan.slices).toBe(1);
    expect(plan.partial).toBe(false);
  });

  it("covers a multi-viewport page exactly", () => {
    const plan = planFullPageCapture(metrics(2400), LIMITS); // 3 × 800
    expect(plan.slices).toBe(3);
    expect(plan.partial).toBe(false);
    expect(plan.canvasH).toBe(2400);
    expect(plan.canvasW).toBe(1280);
  });

  it("scales canvas size by devicePixelRatio", () => {
    const plan = planFullPageCapture(metrics(1600, 800, 1280, 2), LIMITS);
    expect(plan.canvasW).toBe(2560);
    expect(plan.canvasH).toBe(3200);
  });

  it("caps very tall pages by slice count and marks them partial", () => {
    const plan = planFullPageCapture(metrics(100_000), LIMITS);
    expect(plan.slices).toBe(20);
    expect(plan.partial).toBe(true);
  });

  it("caps by the device-height budget", () => {
    const plan = planFullPageCapture(metrics(8000, 800, 1280, 2), {
      maxSlices: 20,
      maxDeviceHeight: 4000
    });
    // sliceDeviceH = 1600 → floor(4000/1600) = 2 slices
    expect(plan.slices).toBe(2);
    expect(plan.partial).toBe(true);
  });
});

describe("uint8ToBase64", () => {
  it("matches Buffer base64 for arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 65, 66, 200, 255]);
    expect(uint8ToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("handles an empty buffer", () => {
    expect(uint8ToBase64(new Uint8Array([]))).toBe("");
  });

  it("handles a large buffer without stack overflow", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(uint8ToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
