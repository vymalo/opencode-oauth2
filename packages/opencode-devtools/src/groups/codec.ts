import { deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from "node:zlib";

import { json, reqString, text, type ToolSpec } from "../tool-spec.js";

export const CODEC_TOOLS: readonly ToolSpec[] = [
  {
    name: "codec_base64",
    group: "codec",
    description:
      "Base64 encode or decode text. Supports standard and URL-safe (base64url) alphabets.",
    input: {
      mode: { type: "string", enum: ["encode", "decode"], description: "Direction." },
      input: { type: "string", description: "Text to encode, or base64 to decode." },
      urlSafe: {
        type: "boolean",
        optional: true,
        description: "Use the URL-safe base64url alphabet (default false)."
      }
    },
    handler: (args) => {
      const mode = reqString(args, "mode");
      const input = reqString(args, "input");
      const urlSafe = args.urlSafe === true;
      const encoding = urlSafe ? "base64url" : "base64";
      if (mode === "encode") {
        return text(Buffer.from(input, "utf8").toString(encoding));
      }
      return text(Buffer.from(input, encoding).toString("utf8"));
    }
  },
  {
    name: "codec_hex",
    group: "codec",
    description: "Hex (base16) encode or decode text.",
    input: {
      mode: { type: "string", enum: ["encode", "decode"], description: "Direction." },
      input: { type: "string", description: "Text to encode, or hex to decode." }
    },
    handler: (args) => {
      const mode = reqString(args, "mode");
      const input = reqString(args, "input");
      if (mode === "encode") {
        return text(Buffer.from(input, "utf8").toString("hex"));
      }
      return text(Buffer.from(input.replace(/\s+/g, ""), "hex").toString("utf8"));
    }
  },
  {
    name: "codec_url",
    group: "codec",
    description:
      "URL-encode or decode a string (percent-encoding). Use `component` for a query value, otherwise the whole URL is treated leniently.",
    input: {
      mode: { type: "string", enum: ["encode", "decode"], description: "Direction." },
      input: { type: "string", description: "Text to encode or decode." },
      component: {
        type: "boolean",
        optional: true,
        description: "Encode as a single URI component (default true)."
      }
    },
    handler: (args) => {
      const mode = reqString(args, "mode");
      const input = reqString(args, "input");
      const component = args.component !== false;
      if (mode === "encode") {
        return text(component ? encodeURIComponent(input) : encodeURI(input));
      }
      return text(component ? decodeURIComponent(input) : decodeURI(input));
    }
  },
  {
    name: "codec_jwt_decode",
    group: "codec",
    description:
      "Decode a JWT into its header and payload claims WITHOUT verifying the signature. The result is explicitly unverified — never trust it for auth decisions.",
    input: {
      token: { type: "string", description: "The compact JWT (header.payload.signature)." }
    },
    handler: (args) => {
      const token = reqString(args, "token").trim();
      const parts = token.split(".");
      if (parts.length < 2) {
        throw new Error("not a JWT: expected at least header.payload");
      }
      const decode = (segment: string): unknown => {
        const decoded = Buffer.from(segment, "base64url").toString("utf8");
        return JSON.parse(decoded);
      };
      const header = decode(parts[0]);
      const payload = decode(parts[1]);
      return json(
        {
          header,
          payload,
          signaturePresent: parts.length >= 3 && parts[2].length > 0,
          verified: false
        },
        `Decoded JWT (UNVERIFIED):\nheader: ${JSON.stringify(header)}\npayload: ${JSON.stringify(payload, null, 2)}`
      );
    }
  },
  {
    name: "codec_gzip",
    group: "codec",
    description:
      "Compress or decompress text with gzip or raw deflate. Compressed output is returned as base64; to decompress, pass base64 input.",
    input: {
      mode: { type: "string", enum: ["compress", "decompress"], description: "Direction." },
      input: {
        type: "string",
        description: "Text to compress, or base64 of compressed bytes to decompress."
      },
      algorithm: {
        type: "string",
        optional: true,
        enum: ["gzip", "deflate"],
        description: "Compression algorithm (default gzip)."
      }
    },
    handler: (args) => {
      const mode = reqString(args, "mode");
      const input = reqString(args, "input");
      const algorithm = args.algorithm === "deflate" ? "deflate" : "gzip";
      if (mode === "compress") {
        const raw = Buffer.from(input, "utf8");
        const out = algorithm === "gzip" ? gzipSync(raw) : deflateRawSync(raw);
        return json(
          {
            algorithm,
            base64: out.toString("base64"),
            originalBytes: raw.length,
            compressedBytes: out.length
          },
          out.toString("base64")
        );
      }
      const compressed = Buffer.from(input, "base64");
      const out = algorithm === "gzip" ? gunzipSync(compressed) : inflateRawSync(compressed);
      return text(out.toString("utf8"));
    }
  }
];
