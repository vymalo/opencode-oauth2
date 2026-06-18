import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";
import { DateTime, Duration } from "luxon";

import { json, optString, reqString, type ToolSpec } from "../tool-spec.js";

const DEFAULT_DIFF_UNITS = ["years", "months", "days", "hours", "minutes", "seconds"];

/** Parse an instant from ISO, RFC 2822, SQL, epoch-millis, or an explicit format. */
function parseInstant(
  input: string,
  zone: string | undefined,
  format: string | undefined
): DateTime {
  const opts = zone ? { zone } : {};
  if (format) {
    return DateTime.fromFormat(input, format, opts);
  }
  const trimmed = input.trim();
  if (/^-?\d{10,}$/.test(trimmed)) {
    return DateTime.fromMillis(Number(trimmed), opts);
  }
  const iso = DateTime.fromISO(trimmed, opts);
  if (iso.isValid) {
    return iso;
  }
  const rfc = DateTime.fromRFC2822(trimmed, opts);
  if (rfc.isValid) {
    return rfc;
  }
  const sql = DateTime.fromSQL(trimmed, opts);
  if (sql.isValid) {
    return sql;
  }
  return iso; // invalid; caller reports the reason
}

function ensureValid(dt: DateTime, label: string): DateTime {
  if (!dt.isValid) {
    throw new Error(`${label} is not a valid date/time (${dt.invalidReason ?? "unknown"})`);
  }
  return dt;
}

function describe(dt: DateTime): Record<string, unknown> {
  return {
    iso: dt.toISO(),
    epochMs: dt.toMillis(),
    epochSeconds: Math.floor(dt.toMillis() / 1000),
    zone: dt.zoneName,
    weekday: dt.weekdayLong,
    components: {
      year: dt.year,
      month: dt.month,
      day: dt.day,
      hour: dt.hour,
      minute: dt.minute,
      second: dt.second
    }
  };
}

export const DATETIME_TOOLS: readonly ToolSpec[] = [
  {
    name: "datetime_now",
    group: "datetime",
    description: "Get the current date and time, optionally in a specific IANA timezone.",
    input: {
      zone: {
        type: "string",
        optional: true,
        description: 'IANA timezone, e.g. "Europe/Paris" (default system zone).'
      }
    },
    handler: (args, ctx) => {
      const zone = optString(args, "zone");
      let dt = DateTime.fromJSDate(ctx.now());
      if (zone) {
        dt = dt.setZone(zone);
        ensureValid(dt, `zone "${zone}"`);
      }
      return json(describe(dt), `${dt.toISO()} (${dt.zoneName})`);
    }
  },
  {
    name: "datetime_parse",
    group: "datetime",
    description:
      "Parse a date/time string (ISO 8601, RFC 2822, SQL, epoch-millis, or a custom format) into a normalized ISO timestamp plus its components.",
    input: {
      input: { type: "string", description: "The date/time string to parse." },
      format: {
        type: "string",
        optional: true,
        description: 'Optional Luxon parse format, e.g. "dd/MM/yyyy HH:mm".'
      },
      zone: {
        type: "string",
        optional: true,
        description: "IANA timezone to interpret the input in."
      }
    },
    handler: (args) => {
      const input = reqString(args, "input");
      const dt = ensureValid(
        parseInstant(input, optString(args, "zone"), optString(args, "format")),
        "input"
      );
      return json(describe(dt), `${dt.toISO()} (${dt.zoneName})`);
    }
  },
  {
    name: "datetime_format",
    group: "datetime",
    description:
      "Reformat a date/time into a chosen representation: a Luxon format string, or a preset (iso, rfc2822, http, sql, relative).",
    input: {
      input: { type: "string", description: "The date/time to format (ISO, epoch-millis, …)." },
      format: {
        type: "string",
        description: "Luxon format token string, or one of: iso, rfc2822, http, sql, relative."
      },
      zone: { type: "string", optional: true, description: "IANA timezone for the output." }
    },
    handler: (args, ctx) => {
      const input = reqString(args, "input");
      const format = reqString(args, "format");
      let dt = ensureValid(parseInstant(input, undefined, undefined), "input");
      const zone = optString(args, "zone");
      if (zone) {
        dt = dt.setZone(zone);
        ensureValid(dt, `zone "${zone}"`);
      }
      let out: string | null;
      switch (format) {
        case "iso":
          out = dt.toISO();
          break;
        case "rfc2822":
          out = dt.toRFC2822();
          break;
        case "http":
          out = dt.toHTTP();
          break;
        case "sql":
          out = dt.toSQL();
          break;
        case "relative":
          out = dt.toRelative({ base: DateTime.fromJSDate(ctx.now()) });
          break;
        default:
          out = dt.toFormat(format);
      }
      return json({ input, format, result: out }, out ?? "");
    }
  },
  {
    name: "datetime_diff",
    group: "datetime",
    description:
      "Compute the duration between two date/times, broken down into the requested units (default years→seconds).",
    input: {
      from: { type: "string", description: "Start date/time." },
      to: { type: "string", description: "End date/time." },
      units: {
        type: "array",
        optional: true,
        items: { type: "string" },
        description: 'Units to break the duration into, e.g. ["days","hours"].'
      }
    },
    handler: (args) => {
      const from = ensureValid(parseInstant(reqString(args, "from"), undefined, undefined), "from");
      const to = ensureValid(parseInstant(reqString(args, "to"), undefined, undefined), "to");
      const units = Array.isArray(args.units)
        ? (args.units.filter((u) => typeof u === "string") as string[])
        : DEFAULT_DIFF_UNITS;
      const diff = to.diff(from, units as Parameters<DateTime["diff"]>[1]);
      const obj = diff.toObject();
      return json(
        { from: from.toISO(), to: to.toISO(), milliseconds: diff.toMillis(), duration: obj },
        `${Duration.fromObject(obj).toHuman()} (${diff.toMillis()} ms)`
      );
    }
  },
  {
    name: "datetime_convert_tz",
    group: "datetime",
    description:
      "Convert a date/time from one IANA timezone to another (the instant is preserved).",
    input: {
      input: { type: "string", description: "The date/time to convert." },
      toZone: { type: "string", description: 'Target IANA timezone, e.g. "Asia/Tokyo".' },
      fromZone: {
        type: "string",
        optional: true,
        description: "Source timezone if `input` has no offset (default system zone)."
      }
    },
    handler: (args) => {
      const input = reqString(args, "input");
      const toZone = reqString(args, "toZone");
      const fromZone = optString(args, "fromZone");
      const src = ensureValid(parseInstant(input, fromZone, undefined), "input");
      const dst = src.setZone(toZone);
      ensureValid(dst, `toZone "${toZone}"`);
      return json(
        {
          from: { iso: src.toISO(), zone: src.zoneName },
          to: { iso: dst.toISO(), zone: dst.zoneName }
        },
        `${src.toISO()} (${src.zoneName}) → ${dst.toISO()} (${dst.zoneName})`
      );
    }
  },
  {
    name: "datetime_cron",
    group: "datetime",
    description:
      "Explain a cron expression in plain English and list its next N run times (in an optional IANA timezone).",
    input: {
      expression: { type: "string", description: 'Cron expression, e.g. "0 9 * * 1-5".' },
      count: {
        type: "number",
        optional: true,
        description: "How many upcoming runs to list (default 5)."
      },
      zone: { type: "string", optional: true, description: "IANA timezone to compute runs in." }
    },
    handler: (args, ctx) => {
      const expression = reqString(args, "expression");
      const count =
        typeof args.count === "number" ? Math.min(50, Math.max(1, Math.floor(args.count))) : 5;
      const zone = optString(args, "zone");
      let englishDescription: string;
      try {
        englishDescription = cronstrue.toString(expression, { throwExceptionOnParseError: true });
      } catch (err) {
        throw new Error(
          `invalid cron expression: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      const interval = CronExpressionParser.parse(expression, {
        currentDate: ctx.now(),
        ...(zone ? { tz: zone } : {})
      });
      const next: string[] = [];
      for (let i = 0; i < count; i++) {
        next.push(interval.next().toDate().toISOString());
      }
      return json(
        { expression, description: englishDescription, next },
        `${englishDescription}\nNext ${count}:\n${next.join("\n")}`
      );
    }
  }
];
