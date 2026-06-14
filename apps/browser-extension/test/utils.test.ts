import { describe, expect, it } from "vitest";

import { cn, timeAgo } from "../src/lib/utils";

describe("cn", () => {
  it("joins truthy class names and drops falsy ones", () => {
    expect(cn("a", false, undefined, "b")).toBe("a b");
  });

  it("de-duplicates conflicting tailwind utilities (last wins)", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
});

describe("timeAgo", () => {
  const now = 1_000_000_000_000;

  it("renders seconds under a minute", () => {
    expect(timeAgo(now - 5_000, now)).toBe("5s ago");
    expect(timeAgo(now, now)).toBe("0s ago");
  });

  it("clamps future timestamps to zero", () => {
    expect(timeAgo(now + 10_000, now)).toBe("0s ago");
  });

  it("renders minutes then hours", () => {
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
  });

  it("falls back to an absolute date past a day", () => {
    const out = timeAgo(now - 50 * 3_600_000, now);
    expect(out).not.toMatch(/ago$/);
    expect(out.length).toBeGreaterThan(0);
  });
});
