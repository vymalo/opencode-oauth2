import { describe, expect, it } from "vitest";

import { run } from "./helpers.js";

describe("datetime group", () => {
  it("returns now in a given zone (fixed clock)", async () => {
    const r = await run("datetime_now", { zone: "UTC" });
    const data = (r as { data: Record<string, unknown> }).data;
    expect(data.iso).toContain("2026-06-18T12:00");
    expect(data.epochMs).toBe(Date.parse("2026-06-18T12:00:00.000Z"));
  });

  it("rejects an unknown zone", async () => {
    await expect(run("datetime_now", { zone: "Not/AZone" })).rejects.toThrow(/not a valid/);
  });

  it("parses ISO, epoch and custom formats", async () => {
    const iso = await run("datetime_parse", { input: "2026-06-18T00:00:00Z", zone: "UTC" });
    expect((iso as { data: { epochMs: number } }).data.epochMs).toBe(
      Date.parse("2026-06-18T00:00:00Z")
    );
    const epoch = await run("datetime_parse", { input: "1750000000000" });
    expect((epoch as { data: { epochMs: number } }).data.epochMs).toBe(1750000000000);
    const custom = await run("datetime_parse", {
      input: "18/06/2026 09:30",
      format: "dd/MM/yyyy HH:mm",
      zone: "UTC"
    });
    const c = (custom as { data: { components: Record<string, number> } }).data.components;
    expect(c.day).toBe(18);
    expect(c.hour).toBe(9);
  });

  it("rejects an unparseable input", async () => {
    await expect(run("datetime_parse", { input: "definitely not a date" })).rejects.toThrow(
      /not a valid/
    );
  });

  it("formats via presets and tokens", async () => {
    const iso = await run("datetime_format", {
      input: "1750000000000",
      format: "iso",
      zone: "UTC"
    });
    expect(iso.text).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const tokened = await run("datetime_format", {
      input: "2026-06-18T00:00:00Z",
      format: "yyyy-MM-dd",
      zone: "UTC"
    });
    expect(tokened.text).toBe("2026-06-18");
    const rel = await run("datetime_format", { input: "2026-06-18T11:00:00Z", format: "relative" });
    expect(rel.text).toContain("hour");
  });

  it("computes a duration diff", async () => {
    const r = await run("datetime_diff", {
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T06:00:00Z",
      units: ["hours"]
    });
    const data = (r as { data: { duration: { hours: number } } }).data;
    expect(data.duration.hours).toBe(30);
  });

  it("converts between timezones preserving the instant", async () => {
    const r = await run("datetime_convert_tz", {
      input: "2026-06-18T12:00:00Z",
      toZone: "Asia/Tokyo"
    });
    const to = (r as { data: { to: { iso: string } } }).data.to;
    expect(to.iso).toContain("21:00");
    expect(to.iso).toContain("+09:00");
  });

  it("explains a cron expression and lists next runs", async () => {
    const r = await run("datetime_cron", { expression: "0 9 * * 1-5", count: 3, zone: "UTC" });
    const data = (r as { data: { description: string; next: string[] } }).data;
    expect(data.description.toLowerCase()).toContain("9");
    expect(data.next).toHaveLength(3);
    // First run after the fixed 2026-06-18 (a Thursday) at 12:00 UTC is the 19th 09:00 UTC.
    expect(data.next[0]).toBe("2026-06-19T09:00:00.000Z");
  });

  it("rejects an invalid cron expression", async () => {
    await expect(run("datetime_cron", { expression: "not cron" })).rejects.toThrow(/invalid cron/);
  });

  it("parses RFC 2822 and SQL inputs", async () => {
    const rfc = await run("datetime_parse", { input: "18 Jun 2026 08:00:00 +0000" });
    expect((rfc as { data: { components: { year: number } } }).data.components.year).toBe(2026);
    const sql = await run("datetime_parse", { input: "2026-06-18 09:30:00", zone: "UTC" });
    expect((sql as { data: { components: { hour: number } } }).data.components.hour).toBe(9);
  });

  it("formats via rfc2822, http and sql presets", async () => {
    const base = { input: "2026-06-18T00:00:00Z", zone: "UTC" };
    expect((await run("datetime_format", { ...base, format: "rfc2822" })).text).toContain("2026");
    expect((await run("datetime_format", { ...base, format: "http" })).text).toContain("GMT");
    expect((await run("datetime_format", { ...base, format: "sql" })).text).toContain("2026-06-18");
  });
});
