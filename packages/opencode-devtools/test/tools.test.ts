import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../src/logging.js";
import { createDevtoolsTools } from "../src/tools.js";
import { options } from "./helpers.js";

function fakeLogger(): Logger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("createDevtoolsTools", () => {
  it("registers only the enabled groups", () => {
    const tools = createDevtoolsTools({
      options: options({ groups: ["math"] }),
      logger: fakeLogger()
    });
    const names = Object.keys(tools);
    expect(names).toContain("math_eval");
    expect(names.some((n) => n.startsWith("codec_"))).toBe(false);
    expect(names.some((n) => n.startsWith("http_"))).toBe(false);
  });

  it("includes http only when its group is enabled", () => {
    const tools = createDevtoolsTools({
      options: options({ groups: ["http"] }),
      logger: fakeLogger()
    });
    expect(Object.keys(tools)).toEqual(["http_request", "http_graphql"]);
  });

  it("renders a text result as a string", async () => {
    const tools = createDevtoolsTools({
      options: options({ groups: ["codec"] }),
      logger: fakeLogger()
    });
    const out = await tools.codec_base64.execute({ mode: "encode", input: "hi" }, {} as never);
    expect(out).toBe("aGk=");
  });

  it("renders a json result as output + metadata", async () => {
    const tools = createDevtoolsTools({
      options: options({ groups: ["math"] }),
      logger: fakeLogger()
    });
    const out = (await tools.math_stats.execute({ values: [2, 4] }, {} as never)) as {
      output: string;
      metadata: Record<string, unknown>;
    };
    expect(out.metadata.mean).toBe(3);
    expect(typeof out.output).toBe("string");
  });

  it("logs and rethrows handler errors", async () => {
    const logger = fakeLogger();
    const tools = createDevtoolsTools({ options: options({ groups: ["math"] }), logger });
    await expect(tools.math_eval.execute({ expression: 1 }, {} as never)).rejects.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      "devtools_tool_failed",
      expect.objectContaining({ tool: "math_eval" })
    );
  });

  it("threads the injected context (clock/randomness) into handlers", async () => {
    const tools = createDevtoolsTools({
      options: options({ groups: ["crypto"] }),
      logger: fakeLogger(),
      context: { randomBytes: (n: number) => Buffer.alloc(n, 0) }
    });
    const out = await tools.crypto_random.execute({ bytes: 4 }, {} as never);
    expect(out).toBe("00000000");
  });
});
