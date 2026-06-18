import TOML from "@iarna/toml";
import { JSONPath } from "jsonpath-plus";
import Papa from "papaparse";
import YAML from "yaml";

import { json, reqString, type ToolSpec } from "../tool-spec.js";

type Format = "json" | "yaml" | "toml" | "csv";
const FORMATS = ["json", "yaml", "toml", "csv"] as const;

function decode(input: string, format: Format): unknown {
  switch (format) {
    case "json":
      return JSON.parse(input);
    case "yaml":
      return YAML.parse(input);
    case "toml":
      return TOML.parse(input);
    case "csv": {
      // dynamicTyping is intentionally OFF: it would coerce "00123" → 123 (losing
      // leading zeros) and round 64-bit IDs, silently corrupting the data. Keep
      // every field as a string for a faithful conversion.
      const parsed = Papa.parse(input.trim(), {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: false
      });
      if (parsed.errors.length > 0) {
        throw new Error(`CSV parse error: ${parsed.errors[0].message}`);
      }
      return parsed.data;
    }
  }
}

function encode(value: unknown, format: Format): string {
  switch (format) {
    case "json":
      return JSON.stringify(value, null, 2);
    case "yaml":
      return YAML.stringify(value);
    case "toml":
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("TOML output requires a top-level object (table)");
      }
      return TOML.stringify(value as TOML.JsonMap);
    case "csv": {
      const rows = Array.isArray(value) ? value : [value];
      return Papa.unparse(rows as object[]);
    }
  }
}

export const CONVERT_TOOLS: readonly ToolSpec[] = [
  {
    name: "convert_data",
    group: "convert",
    description:
      "Convert structured data between JSON, YAML, TOML and CSV. CSV maps to/from an array of row objects; TOML output needs a top-level object.",
    input: {
      input: { type: "string", description: "The source document." },
      from: { type: "string", enum: FORMATS, description: "Source format." },
      to: { type: "string", enum: FORMATS, description: "Target format." }
    },
    handler: (args) => {
      const input = reqString(args, "input");
      const from = reqString(args, "from") as Format;
      const to = reqString(args, "to") as Format;
      const value = decode(input, from);
      const out = encode(value, to);
      return json({ from, to, result: out }, out);
    }
  },
  {
    name: "convert_query",
    group: "convert",
    description:
      'Run a JSONPath query against a JSON, YAML or TOML document and return the matching values. Example path: "$.items[*].name".',
    input: {
      input: { type: "string", description: "The source document." },
      path: { type: "string", description: 'JSONPath expression, e.g. "$.store.book[*].author".' },
      from: {
        type: "string",
        optional: true,
        enum: ["json", "yaml", "toml"],
        description: "Source format (default json)."
      }
    },
    handler: (args) => {
      const input = reqString(args, "input");
      const path = reqString(args, "path");
      const from = (typeof args.from === "string" ? args.from : "json") as Format;
      const value = decode(input, from);
      // eval: false disables script/filter expressions (`[?(...)]`) — they run
      // arbitrary JS via the engine. `path` is model-supplied, so this keeps the
      // tool deterministic (no sandbox escape). Standard path queries still work.
      const matches = JSONPath({
        path,
        json: value as object,
        wrap: true,
        eval: false
      }) as unknown[];
      return json(
        { path, count: matches.length, matches },
        matches.length === 0 ? "(no matches)" : JSON.stringify(matches, null, 2)
      );
    }
  }
];
