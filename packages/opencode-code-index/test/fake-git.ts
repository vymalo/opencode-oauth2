import type { GitRunner } from "../src/git.js";

export interface FakeGitState {
  branch: string;
  /** path -> blob sha */
  tree: Record<string, string>;
  /** blob sha -> contents */
  blobs: Record<string, string>;
  isRepo?: boolean;
  rootSha?: string;
}

/** A GitRunner backed by an in-memory state object (mutate it to simulate branch switches). */
export function fakeRunner(state: FakeGitState): GitRunner {
  return async (args) => {
    const [cmd, ...rest] = args;
    if (cmd === "rev-parse" && rest.includes("--is-inside-work-tree")) {
      return `${state.isRepo === false ? "false" : "true"}\n`;
    }
    if (cmd === "rev-parse" && rest.includes("--abbrev-ref")) {
      return `${state.branch}\n`;
    }
    if (cmd === "rev-parse" && rest.includes("--short")) {
      return "abcdef0\n";
    }
    if (cmd === "rev-list") {
      return `${state.rootSha ?? "root0"}\n`;
    }
    if (cmd === "ls-tree") {
      const records = Object.entries(state.tree).map(([p, sha]) => `100644 blob ${sha}\t${p}`);
      return records.length ? `${records.join("\0")}\0` : "";
    }
    if (cmd === "cat-file") {
      const sha = rest[rest.length - 1];
      const content = state.blobs[sha];
      if (content === undefined) {
        throw new Error(`fake-git: unknown blob ${sha}`);
      }
      return content;
    }
    throw new Error(`fake-git: unexpected args ${args.join(" ")}`);
  };
}

/** The canonical handler -> login -> auth -> util chain used across tests. */
export function chainState(branch: "main" | "feature"): FakeGitState {
  const blobs: Record<string, string> = {
    util: "export function util() { return 1; }",
    authA: 'import { util } from "./util";\nexport function auth() { return util(); }',
    authB: "export function auth() { return 2; }",
    login: 'import { auth } from "./auth";\nexport function login() { return auth(); }',
    handler: 'import { login } from "./login";\nexport function handler() { return login(); }',
    readme: "# not code"
  };
  const tree: Record<string, string> = {
    "src/util.ts": "util",
    "src/login.ts": "login",
    "src/handler.ts": "handler",
    "README.md": "readme",
    "src/auth.ts": branch === "main" ? "authA" : "authB"
  };
  return { branch, tree, blobs };
}
