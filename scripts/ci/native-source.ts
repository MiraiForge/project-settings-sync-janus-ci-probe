import { execFileSync } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const REPOSITORY = "aditzel/project-settings-sync";
const WORKFLOW = ".github/workflows/ci.yml";
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 4096;
type Environment = Record<string, string | undefined>;
type RecordValue = Record<string, unknown>;

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error("Native source identity could not be verified");
}

function record(value: unknown): RecordValue {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as RecordValue;
}

function sha(value: unknown): string {
  requireValue(typeof value === "string" && /^[0-9a-f]{40}$/.test(value) && !/^0+$/.test(value));
  return value;
}

function identifier(value: unknown): string {
  requireValue(typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value));
  requireValue(Number.isSafeInteger(Number(value)));
  return value;
}

function numericIdentifier(value: unknown): string {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  return identifier(String(value));
}

export function readEvent(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(fd);
    requireValue(stats.isFile() && stats.size > 0 && stats.size <= MAX_EVENT_BYTES);
    const bytes = Buffer.alloc(MAX_EVENT_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    requireValue(size > 0 && size <= MAX_EVENT_BYTES);
    return JSON.parse(bytes.subarray(0, size).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

export function readGitFacts(workspace: string) {
  // Ignore replacement objects, user/system configuration and inherited Git overrides.
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["--no-replace-objects", "-C", workspace, "-c", "core.fsmonitor=false", ...args],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          LC_ALL: "C",
        },
        timeout: 10_000,
        maxBuffer: 256 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).trim();
  requireValue(realpathSync(git("rev-parse", "--show-toplevel")) === realpathSync(workspace));
  const origin = git("config", "--get", "remote.origin.url");
  requireValue(
    origin === `https://github.com/${REPOSITORY}` ||
      origin === `https://github.com/${REPOSITORY}.git`
  );
  const testedSha = sha(git("rev-parse", "--verify", "HEAD^{commit}"));
  // rev-list/show %P hide parents at shallow boundaries; raw commit headers do not.
  const headers = git("cat-file", "commit", testedSha).split("\n\n", 1)[0]!.split("\n");
  const trees = headers.filter((line) => line.startsWith("tree "));
  requireValue(trees.length === 1);
  const treeSha = sha(trees[0]!.slice(5));
  const parents = headers
    .filter((line) => line.startsWith("parent "))
    .map((line) => sha(line.slice(7)));
  requireValue(parents.length <= 16 && new Set(parents).size === parents.length);
  requireValue(git("status", "--porcelain=v1", "--untracked-files=normal") === "");
  return { testedSha, treeSha, parents };
}

export function captureIdentity(
  env: Environment,
  payload: unknown,
  facts: ReturnType<typeof readGitFacts>
) {
  requireValue(
    env.GITHUB_SERVER_URL === "https://github.com" && env.GITHUB_REPOSITORY === REPOSITORY
  );
  requireValue(env.GITHUB_WORKFLOW === "CI" && env.GITHUB_JOB === "test");
  requireValue(env.RUNNER_OS === "macOS" && env.RUNNER_ENVIRONMENT === "github-hosted");
  const repositoryId = identifier(env.GITHUB_REPOSITORY_ID);
  const runId = identifier(env.GITHUB_RUN_ID);
  const runAttempt = identifier(env.GITHUB_RUN_ATTEMPT);
  requireValue(Number(runAttempt) <= 999999);
  const event = record(payload);
  const repository = record(event.repository);
  requireValue(
    repository.full_name === REPOSITORY && numericIdentifier(repository.id) === repositoryId
  );
  const testedSha = sha(facts.testedSha);
  const treeSha = sha(facts.treeSha);
  requireValue(facts.parents.length <= 16);
  const parents = facts.parents.map(sha);
  requireValue(new Set(parents).size === parents.length);
  requireValue(sha(env.GITHUB_SHA) === testedSha && sha(env.GITHUB_WORKFLOW_SHA) === testedSha);
  requireValue(env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/${WORKFLOW}@${env.GITHUB_REF}`);
  let sourceSha: string;
  let baseSha: string | null = null;
  let pullRequest: number | null = null;
  if (env.GITHUB_EVENT_NAME === "push") {
    requireValue(env.GITHUB_REF === "refs/heads/main" && event.ref === env.GITHUB_REF);
    requireValue(event.deleted === false);
    sourceSha = sha(event.after);
    requireValue(sourceSha === testedSha);
  } else {
    requireValue(env.GITHUB_EVENT_NAME === "pull_request");
    requireValue(["opened", "reopened", "synchronize"].includes(String(event.action)));
    const pr = record(event.pull_request);
    pullRequest = Number(numericIdentifier(event.number));
    requireValue(pullRequest <= 2147483647 && numericIdentifier(pr.number) === String(pullRequest));
    requireValue(pr.state === "open" && pr.merged === false);
    const head = record(pr.head);
    const base = record(pr.base);
    for (const source of [head, base]) {
      const repo = record(source.repo);
      requireValue(repo.full_name === REPOSITORY && numericIdentifier(repo.id) === repositoryId);
    }
    requireValue(base.ref === "main" && env.GITHUB_BASE_REF === "main");
    requireValue(env.GITHUB_REF === `refs/pull/${pullRequest}/merge`);
    sourceSha = sha(head.sha);
    baseSha = sha(base.sha);
    requireValue(sourceSha !== baseSha && testedSha !== sourceSha && testedSha !== baseSha);
    requireValue(parents.length === 2 && parents[0] === baseSha && parents[1] === sourceSha);
  }
  return {
    schemaVersion: 1,
    repository: REPOSITORY,
    repositoryId,
    event: env.GITHUB_EVENT_NAME,
    workflowPath: WORKFLOW,
    workflowSha: testedSha,
    job: "test",
    matrixOs: "macos-latest",
    runId,
    runAttempt,
    ref: env.GITHUB_REF,
    pullRequest,
    sourceSha,
    baseSha,
    testedSha,
    treeSha,
    parents,
  };
}

export function capture(env: Environment) {
  requireValue(process.platform === "darwin");
  requireValue(env.GITHUB_WORKSPACE && env.GITHUB_EVENT_PATH && env.RUNNER_TEMP);
  const evidence = captureIdentity(
    env,
    readEvent(env.GITHUB_EVENT_PATH),
    readGitFacts(env.GITHUB_WORKSPACE)
  );
  const json = `${JSON.stringify(evidence)}\n`;
  requireValue(Buffer.byteLength(json) <= MAX_EVIDENCE_BYTES);
  const directory = join(
    env.RUNNER_TEMP,
    `native-macos-source-${evidence.runId}-${evidence.runAttempt}`
  );
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "source.json"), json, { flag: "wx", mode: 0o400 });
}

if (import.meta.main) {
  try {
    capture(process.env);
    console.log("Native source evidence captured");
  } catch {
    // Never print an event, environment, Git stderr, token, or untrusted identity.
    console.error("Native source identity could not be verified");
    process.exitCode = 1;
  }
}
