import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { captureIdentity, readEvent, readGitFacts } from "./native-source.ts";

const roots: string[] = [];
const script = resolve(import.meta.dirname, "native-source.ts");
const repo = { full_name: "aditzel/project-settings-sync", id: 123456 };
const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Write disposable loose Git objects directly, then ask the actual Git executable to
// read them. No repository history, credentials, network, or mocked Git output is used.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-source-test-"));
  roots.push(root);
  const workspace = join(root, "checkout");
  mkdirSync(join(workspace, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(
    join(workspace, ".git", "config"),
    '[core]\nrepositoryformatversion = 0\nbare = false\n[remote "origin"]\nurl = https://github.com/aditzel/project-settings-sync.git\n'
  );
  const object = (kind: string, body: string) => {
    const data = Buffer.from(`${kind} ${Buffer.byteLength(body)}\0${body}`);
    const hash = createHash("sha1").update(data).digest("hex");
    const path = join(workspace, ".git", "objects", hash.slice(0, 2), hash.slice(2));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, deflateSync(data));
    return hash;
  };
  expect(object("tree", "")).toBe(tree);
  const commit = (message: string, parents: string[] = []) =>
    object(
      "commit",
      `tree ${tree}\n${parents.map((sha) => `parent ${sha}\n`).join("")}author Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\n${message}\n`
    );
  const base = commit("base");
  const head = commit("source", [base]);
  const merge = commit("merge", [base, head]);
  const checkout = (sha: string) => writeFileSync(join(workspace, ".git", "HEAD"), `${sha}\n`);
  checkout(merge);
  const env = {
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: repo.full_name,
    GITHUB_REPOSITORY_ID: String(repo.id),
    GITHUB_WORKFLOW: "CI",
    GITHUB_WORKFLOW_REF: `${repo.full_name}/.github/workflows/ci.yml@refs/pull/42/merge`,
    GITHUB_WORKFLOW_SHA: merge,
    GITHUB_JOB: "test",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REF: "refs/pull/42/merge",
    GITHUB_BASE_REF: "main",
    GITHUB_SHA: merge,
    GITHUB_RUN_ID: "39123456789",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_WORKSPACE: workspace,
    GITHUB_EVENT_PATH: join(root, "event.json"),
    RUNNER_OS: "macOS",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_TEMP: root,
  };
  const event = {
    repository: repo,
    action: "synchronize",
    number: 42,
    pull_request: {
      number: 42,
      state: "open",
      merged: false,
      head: { sha: head, repo },
      base: { sha: base, ref: "main", repo },
    },
  };
  const evidence = () => captureIdentity(env, event, readGitFacts(workspace));
  const cli = (payload: unknown = event) => {
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(payload));
    return spawnSync("bun", ["--no-env-file", "--no-install", "--config=/dev/null", script], {
      cwd: root,
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8",
      timeout: 15_000,
    });
  };
  return { root, workspace, env, event, base, head, merge, commit, checkout, evidence, cli };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native checkout identity", () => {
  it("binds a real shallow merge object to ordered base/source parents and attempt", () => {
    const f = fixture();
    writeFileSync(join(f.workspace, ".git", "shallow"), `${f.merge}\n`);
    expect(
      execFileSync("git", ["-C", f.workspace, "show", "-s", "--format=%P", "HEAD"], {
        encoding: "utf8",
      }).trim()
    ).toBe("");
    expect(f.evidence()).toEqual({
      schemaVersion: 1,
      repository: repo.full_name,
      repositoryId: String(repo.id),
      event: "pull_request",
      workflowPath: ".github/workflows/ci.yml",
      workflowSha: f.merge,
      job: "test",
      matrixOs: "macos-latest",
      runId: "39123456789",
      runAttempt: "2",
      ref: "refs/pull/42/merge",
      pullRequest: 42,
      sourceSha: f.head,
      baseSha: f.base,
      testedSha: f.merge,
      treeSha: tree,
      parents: [f.base, f.head],
    });
  });

  it("records push main only when the actual checkout equals the event source", () => {
    const f = fixture();
    f.checkout(f.head);
    const env = {
      ...f.env,
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: f.head,
      GITHUB_WORKFLOW_SHA: f.head,
      GITHUB_WORKFLOW_REF: `${repo.full_name}/.github/workflows/ci.yml@refs/heads/main`,
    };
    const payload = { repository: repo, ref: env.GITHUB_REF, after: f.head, deleted: false };
    const result = captureIdentity(env, payload, readGitFacts(f.workspace));
    expect(result.sourceSha).toBe(f.head);
    expect(result.testedSha).toBe(f.head);
    expect(result.baseSha).toBeNull();
    expect(result.pullRequest).toBeNull();
    expect(() =>
      captureIdentity(env, { ...payload, after: f.base }, readGitFacts(f.workspace))
    ).toThrow();
    expect(() =>
      captureIdentity(env, { ...payload, deleted: true }, readGitFacts(f.workspace))
    ).toThrow();
    expect(() =>
      captureIdentity(env, { ...payload, ref: "refs/heads/other" }, readGitFacts(f.workspace))
    ).toThrow();
  });

  it.each(["reversed", "one-parent", "wrong-parent", "extra-parent", "head-only"])(
    "rejects actual %s checkout topology",
    (kind) => {
      const f = fixture();
      const other = f.commit("unrelated");
      const parents =
        kind === "reversed"
          ? [f.head, f.base]
          : kind === "one-parent"
            ? [f.head]
            : kind === "wrong-parent"
              ? [other, f.head]
              : [f.base, f.head, other];
      const tested = kind === "head-only" ? f.head : f.commit("wrong merge", parents);
      f.checkout(tested);
      f.env.GITHUB_SHA = tested;
      f.env.GITHUB_WORKFLOW_SHA = tested;
      expect(f.evidence).toThrow();
    }
  );

  it.each([
    ["GITHUB_REPOSITORY", "attacker/project-settings-sync"],
    ["GITHUB_SERVER_URL", "https://elsewhere.invalid"],
    ["GITHUB_REPOSITORY_ID", "999"],
    ["GITHUB_WORKFLOW", "Other"],
    ["GITHUB_JOB", "build"],
    ["GITHUB_WORKFLOW_REF", `${repo.full_name}/.github/workflows/other.yml@refs/pull/42/merge`],
    ["GITHUB_WORKFLOW_SHA", "a".repeat(40)],
    ["GITHUB_SHA", "a".repeat(40)],
    ["GITHUB_SHA", "0".repeat(40)],
    ["GITHUB_SHA", "a".repeat(40000)],
    ["GITHUB_EVENT_NAME", "pull_request_target"],
    ["GITHUB_EVENT_NAME", "workflow_dispatch"],
    ["GITHUB_REF", "refs/pull/43/merge"],
    ["GITHUB_BASE_REF", "release"],
    ["RUNNER_OS", "Linux"],
    ["RUNNER_ENVIRONMENT", "self-hosted"],
    ["GITHUB_RUN_ID", "0"],
    ["GITHUB_RUN_ID", "01"],
    ["GITHUB_RUN_ID", "9007199254740992"],
    ["GITHUB_RUN_ID", "39123456789\n"],
    ["GITHUB_RUN_ATTEMPT", ""],
    ["GITHUB_RUN_ATTEMPT", "1000000"],
    ["GITHUB_RUN_ATTEMPT", "2/../1"],
  ])("rejects invalid or mismatched %s", (key, value) => {
    const f = fixture();
    expect(() =>
      captureIdentity({ ...f.env, [key]: value }, f.event, readGitFacts(f.workspace))
    ).toThrow();
  });

  it("rejects every missing required environment field", () => {
    const f = fixture();
    const facts = readGitFacts(f.workspace);
    for (const key of Object.keys(f.env).filter(
      (key) => !["GITHUB_WORKSPACE", "GITHUB_EVENT_PATH", "RUNNER_TEMP"].includes(key)
    )) {
      expect(() => captureIdentity({ ...f.env, [key]: undefined }, f.event, facts), key).toThrow();
    }
  });

  it.each([
    "fork",
    "renamed-repository-id",
    "missing-head-repo",
    "wrong-base",
    "wrong-number",
    "closed",
    "unsupported-action",
    "invalid-sha",
    "null-payload",
  ])("rejects %s event evidence", (kind) => {
    const f = fixture();
    const event = structuredClone(f.event);
    if (kind === "fork") event.pull_request.head.repo = { ...repo, full_name: "attacker/fork" };
    if (kind === "renamed-repository-id") event.pull_request.head.repo.id = 999;
    if (kind === "missing-head-repo") Reflect.deleteProperty(event.pull_request.head, "repo");
    if (kind === "wrong-base") event.pull_request.base.ref = "other";
    if (kind === "wrong-number") event.number = 43;
    if (kind === "closed") event.pull_request.state = "closed";
    if (kind === "unsupported-action") event.action = "edited";
    if (kind === "invalid-sha") event.pull_request.head.sha = "A".repeat(40);
    expect(() =>
      captureIdentity(f.env, kind === "null-payload" ? null : event, readGitFacts(f.workspace))
    ).toThrow();
  });

  it("rejects a dirty checkout and a different origin", () => {
    const f = fixture();
    writeFileSync(join(f.workspace, "untracked.txt"), "altered before capture");
    expect(() => readGitFacts(f.workspace)).toThrow();
    rmSync(join(f.workspace, "untracked.txt"));
    writeFileSync(
      join(f.workspace, ".git", "config"),
      '[remote "origin"]\nurl = https://github.com/attacker/fork\n'
    );
    expect(() => readGitFacts(f.workspace)).toThrow();
  });

  it("ignores Git replacement objects when observing the actual checkout", () => {
    const f = fixture();
    const replacement = f.commit("replacement", [f.head, f.base]);
    mkdirSync(join(f.workspace, ".git", "refs", "replace"));
    writeFileSync(join(f.workspace, ".git", "refs", "replace", f.merge), `${replacement}\n`);
    expect(f.evidence().parents).toEqual([f.base, f.head]);
  });
});

describe("bounded artifact and process boundary", () => {
  it.each(["too-large", "malformed", "empty", "symlink", "directory"])(
    "rejects %s event files",
    (kind) => {
      const f = fixture();
      const path = f.env.GITHUB_EVENT_PATH;
      if (kind === "too-large") writeFileSync(path, " ".repeat(2 * 1024 * 1024 + 1));
      if (kind === "malformed") writeFileSync(path, "{secret: invalid}");
      if (kind === "empty") writeFileSync(path, "");
      if (kind === "symlink") symlinkSync(join(f.workspace, ".git", "config"), path);
      if (kind === "directory") mkdirSync(path);
      expect(() => readEvent(path)).toThrow();
    }
  );

  it("does not print supplied secret fields or partial evidence on failure", () => {
    const f = fixture();
    f.env.GITHUB_SHA = "secret-marker-invalid-identity";
    const result = f.cli({ ...f.event, secret: "secret-marker-private-event" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Native source identity could not be verified\n");
    expect(readdirSync(f.root).filter((name) => name.startsWith("native-macos-source-"))).toEqual(
      []
    );
  });

  it.skipIf(process.platform !== "darwin")(
    "does not load ambient Bun configuration or environment files",
    () => {
      const f = fixture();
      writeFileSync(join(f.root, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
      writeFileSync(join(f.root, "preload.ts"), 'throw new Error("ambient-preload-executed");\n');
      writeFileSync(join(f.root, ".env"), "NODE_OPTIONS=--invalid-ambient-option\n");
      const result = f.cli();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("Native source evidence captured\n");
    }
  );

  it.skipIf(process.platform !== "darwin")(
    "writes only the bounded schema and refuses to replace an attempt",
    () => {
      const f = fixture();
      const result = f.cli({ ...f.event, token: "secret-marker-private-event" });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("Native source evidence captured\n");
      const path = join(
        f.root,
        `native-macos-source-${f.env.GITHUB_RUN_ID}-${f.env.GITHUB_RUN_ATTEMPT}`,
        "source.json"
      );
      const bytes = readFileSync(path);
      expect(bytes.length).toBeLessThanOrEqual(4096);
      expect(bytes.toString()).not.toContain("secret-marker");
      expect(JSON.parse(bytes.toString())).toEqual(f.evidence());
      expect(f.cli().status).toBe(1);
      expect(readFileSync(path).equals(bytes)).toBe(true);
      f.env.GITHUB_RUN_ATTEMPT = "3";
      expect(f.cli().status).toBe(0);
      expect(
        JSON.parse(
          readFileSync(
            join(f.root, `native-macos-source-${f.env.GITHUB_RUN_ID}-3`, "source.json"),
            "utf8"
          )
        ).runAttempt
      ).toBe("3");
    }
  );
});
