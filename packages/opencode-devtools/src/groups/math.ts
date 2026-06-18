import { all, create } from "mathjs";

import { json, reqNumber, reqString, type ToolSpec } from "../tool-spec.js";

/**
 * A hardened mathjs instance. We use BigNumber for precise decimal arithmetic
 * and disable every function that can mutate the evaluator or reach outside the
 * expression sandbox. `evaluate` itself parses mathjs's own expression language
 * (not JavaScript), so with `import` / `createUnit` / function-assignment
 * removed there is no path to arbitrary code execution. See plans/devtools.md
 * and the math-sandbox ADR.
 */
const math = create(all, { number: "BigNumber", precision: 64 });
const disabled = () => {
  throw new Error("disabled for security");
};
math.import(
  {
    import: disabled,
    createUnit: disabled,
    reviver: disabled,
    splitUnit: disabled
  },
  { override: true }
);

const RADIX_PREFIX: Record<number, string> = { 2: "0b", 8: "0o", 16: "0x" };

function parseInRadix(value: string, radix: number): number {
  const trimmed = value.trim().replace(/^0[box]/i, "");
  // Number.parseInt stops at the first illegal digit (so "1012" in base 2 would
  // silently parse as 5). Require EVERY digit to be legal for the radix.
  const allLegal =
    trimmed.length > 0 &&
    [...trimmed.toLowerCase()].every((ch) => {
      const d = Number.parseInt(ch, radix);
      return !Number.isNaN(d) && d < radix;
    });
  if (!allLegal) {
    throw new Error(`"${value}" is not a valid base-${radix} integer`);
  }
  return Number.parseInt(trimmed, radix);
}

export const MATH_TOOLS: readonly ToolSpec[] = [
  {
    name: "math_eval",
    group: "math",
    description:
      'Evaluate a mathematical expression with arbitrary-precision (64-digit) decimals. Supports arithmetic, functions (sqrt, log, sin, …), constants (pi, e), and inline unit math (e.g. "3 inch to cm"). Sandboxed: no code execution.',
    input: {
      expression: {
        type: "string",
        description: 'Expression to evaluate, e.g. "(2 + 3) * 4" or "sqrt(2)" or "5 km to miles".'
      }
    },
    handler: (args) => {
      const expression = reqString(args, "expression");
      const result = math.evaluate(expression);
      const formatted = math.format(result, { precision: 64 });
      return json({ expression, result: formatted }, formatted);
    }
  },
  {
    name: "math_convert_unit",
    group: "math",
    description:
      "Convert a physical quantity from one unit to another (length, mass, time, temperature, data, energy, …). Returns the converted value.",
    input: {
      value: { type: "number", description: "Numeric magnitude to convert." },
      from: { type: "string", description: 'Source unit, e.g. "km", "kg", "celsius", "GB".' },
      to: { type: "string", description: 'Target unit, e.g. "miles", "lbs", "fahrenheit", "MB".' }
    },
    handler: (args) => {
      const value = reqNumber(args, "value");
      const from = reqString(args, "from");
      const to = reqString(args, "to");
      const converted = math.evaluate(`${value} ${from} to ${to}`);
      const formatted = math.format(converted, { precision: 14 });
      return json({ value, from, to, result: formatted }, `${value} ${from} = ${formatted}`);
    }
  },
  {
    name: "math_stats",
    group: "math",
    description:
      "Compute descriptive statistics over a list of numbers: count, sum, min, max, mean, median, mode, variance and standard deviation.",
    input: {
      values: { type: "array", items: { type: "number" }, description: "The numbers to summarize." }
    },
    handler: (args) => {
      const raw = args.values;
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('"values" must be a non-empty array of numbers');
      }
      const values = raw.map((v, i) => {
        if (typeof v !== "number" || Number.isNaN(v)) {
          throw new Error(`values[${i}] is not a number`);
        }
        return v;
      });
      const num = (x: unknown): number => Number(math.format(x, { precision: 14 }));
      const stats = {
        count: values.length,
        sum: num(math.sum(values)),
        min: num(math.min(values)),
        max: num(math.max(values)),
        mean: num(math.mean(values)),
        median: num(math.median(values)),
        mode: (math.mode(values) as number[]).map(num),
        variance: num(math.variance(values)),
        stdev: num(math.std(values))
      };
      return json(
        stats,
        `n=${stats.count} mean=${stats.mean} median=${stats.median} stdev=${stats.stdev} min=${stats.min} max=${stats.max}`
      );
    }
  },
  {
    name: "math_base",
    group: "math",
    description:
      "Convert an integer between numeric bases (radix 2–36). Common bases (binary, octal, decimal, hex) are returned alongside the requested target.",
    input: {
      value: { type: "string", description: 'Integer to convert, e.g. "255" or "0xff" or "1011".' },
      fromBase: { type: "number", description: "Base of the input value (2–36)." },
      toBase: { type: "number", description: "Base to convert to (2–36)." }
    },
    handler: (args) => {
      const value = reqString(args, "value");
      const fromBase = reqNumber(args, "fromBase");
      const toBase = reqNumber(args, "toBase");
      for (const [label, b] of [
        ["fromBase", fromBase],
        ["toBase", toBase]
      ] as const) {
        if (!Number.isInteger(b) || b < 2 || b > 36) {
          throw new Error(`"${label}" must be an integer in 2–36`);
        }
      }
      const n = parseInRadix(value, fromBase);
      const out = n.toString(toBase);
      const prefix = RADIX_PREFIX[toBase] ?? "";
      return json(
        {
          decimal: n,
          result: out,
          binary: n.toString(2),
          octal: n.toString(8),
          hex: n.toString(16)
        },
        `${value} (base ${fromBase}) = ${prefix}${out} (base ${toBase})`
      );
    }
  }
];
