/**
 * Overleaf Git integration. Overleaf exposes each project as a git repo at
 *   https://git:<TOKEN>@git.overleaf.com/<projectId>
 * where <TOKEN> is the OL_GIT_AUTHENTICATION_TOKEN and the username is "git".
 *
 * Supersedes the earlier projectIDparser.ts, which read the wrong env var and
 * hardcoded the "master" branch. This module detects the real default branch,
 * guards against path traversal, and never logs the token.
 */
import { simpleGit } from "simple-git";
import type { SimpleGit } from "simple-git";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { config } from "../config.js";

const OBJECT_ID_RE = /[0-9a-f]{24}/i;

export interface ParsedProject {
  projectId: string;
  gitUrl: string;
  /** Web URL for humans to review the project. */
  webUrl: string;
}

/** Accept a full Overleaf URL or a bare project id; return the authed git URL. */
export function parseProject(input: string): ParsedProject {
  const trimmed = (input || "").trim();
  if (!trimmed) throw new Error("No Overleaf project provided (URL or 24-char id).");

  let projectId = trimmed;
  if (trimmed.includes("/") || trimmed.includes("overleaf")) {
    const m = trimmed.match(OBJECT_ID_RE);
    if (m) {
      projectId = m[0];
    } else {
      try {
        projectId = new URL(trimmed).pathname.split("/").filter(Boolean).pop() ?? trimmed;
      } catch {
        /* leave as-is */
      }
    }
  }

  if (!/^[0-9a-f]{24}$/i.test(projectId)) {
    throw new Error(`Could not extract a valid Overleaf project id from "${input}".`);
  }
  const token = config.overleafToken;
  if (!token) {
    throw new Error("OL_GIT_AUTHENTICATION_TOKEN is not set. Add it to .env (Overleaf → Account → Git).");
  }
  return {
    projectId,
    gitUrl: `https://git:${encodeURIComponent(token)}@git.overleaf.com/${projectId}`,
    webUrl: `https://www.overleaf.com/project/${projectId}`,
  };
}

/** Remove any embedded credentials from a string before it's shown/logged. */
export function redact(text: string): string {
  return text.replace(/https:\/\/git:[^@\s]+@/g, "https://git:***@");
}

/** Resolve a repo-relative path, refusing anything that escapes the repo. */
export function safeResolve(repoDir: string, relPath: string): string {
  const abs = resolve(repoDir, relPath);
  const rel = relative(repoDir, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path "${relPath}" escapes the repository.`);
  }
  return abs;
}

export interface SyncResult {
  projectId: string;
  dir: string;
  webUrl: string;
  action: "cloned" | "pulled";
  branch: string;
  texFiles: string[];
}

/**
 * Raised when a project has no Overleaf git access — the project doesn't exist,
 * or git integration isn't enabled for it (it's a premium Overleaf feature).
 * Callers should fall back to local templates rather than treating it as fatal.
 */
export class OverleafAccessError extends Error {
  readonly projectId: string;
  /** True when the answer came from cache (no network call, no token spent). */
  readonly cached: boolean;
  constructor(projectId: string, message: string, cached: boolean) {
    super(message);
    this.name = "OverleafAccessError";
    this.projectId = projectId;
    this.cached = cached;
  }
}

interface AccessRecord {
  status: "no-git-access";
  checkedAt: string;
  reason: string;
}
type AccessCache = Record<string, AccessRecord>;

function accessCachePath(): string {
  return join(config.reposDir, ".access-cache.json");
}

async function readAccessCache(): Promise<AccessCache> {
  try {
    return JSON.parse(await readFile(accessCachePath(), "utf-8")) as AccessCache;
  } catch {
    return {};
  }
}

async function writeAccessRecord(projectId: string, record: AccessRecord): Promise<void> {
  await mkdir(config.reposDir, { recursive: true });
  const cache = await readAccessCache();
  cache[projectId] = record;
  await writeFile(accessCachePath(), JSON.stringify(cache, null, 2), "utf-8");
}

/** Forget cached access failures so the next sync re-checks (all, or one project). */
export async function clearAccessCache(projectId?: string): Promise<void> {
  if (!projectId) {
    await writeFile(accessCachePath(), "{}", "utf-8").catch(() => {});
    return;
  }
  const cache = await readAccessCache();
  delete cache[projectId];
  await writeFile(accessCachePath(), JSON.stringify(cache, null, 2), "utf-8").catch(() => {});
}

/** Overleaf's message when git integration is unavailable for a project. */
function isNoGitAccess(message: string): boolean {
  return /no git access|git access is not enabled|repository not found|project does not exist/i.test(message);
}

export interface SyncOptions {
  /** Re-check even if a previous attempt was cached as having no git access. */
  force?: boolean;
}

/**
 * Clone the project if absent, otherwise pull. Returns repo info + .tex files.
 *
 * If the project has no git access, the failure is cached and subsequent calls
 * short-circuit *before* any network/auth attempt — so a project on a free plan
 * costs exactly one failed request, not one per run.
 */
export async function syncRepo(input: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const { projectId, gitUrl, webUrl } = parseProject(input);
  const dir = join(config.reposDir, projectId);

  // Fast path: previously found to have no git access, and we have no local
  // clone to fall back on. Skip the network entirely (no token spent).
  if (!opts.force && !existsSync(join(dir, ".git"))) {
    const cached = (await readAccessCache())[projectId];
    if (cached) throw new OverleafAccessError(projectId, cached.reason, true);
  }

  await mkdir(config.reposDir, { recursive: true });

  let action: "cloned" | "pulled";
  try {
    if (existsSync(join(dir, ".git"))) {
      // Refresh the remote in case the token rotated, then pull.
      const git = simpleGit(dir);
      await git.remote(["set-url", "origin", gitUrl]);
      await git.pull();
      action = "pulled";
    } else {
      await simpleGit().clone(gitUrl, dir);
      action = "cloned";
    }
  } catch (err) {
    const raw = redact(err instanceof Error ? err.message : String(err));
    if (isNoGitAccess(raw)) {
      await writeAccessRecord(projectId, {
        status: "no-git-access",
        checkedAt: new Date().toISOString(),
        reason: raw.split("\n").slice(0, 3).join(" ").trim(),
      });
      throw new OverleafAccessError(projectId, raw, false);
    }
    throw new Error(raw);
  }

  const git = simpleGit(dir);
  const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
  const texFiles = await listTexFiles(dir);
  return { projectId, dir, webUrl, action, branch, texFiles };
}

/** Recursively list .tex files (repo-relative), skipping .git. */
export async function listTexFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === ".git") continue;
      const abs = join(current, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".tex")) out.push(relative(dir, abs));
    }
  }
  if (existsSync(dir)) await walk(dir);
  return out.sort();
}

export async function readRepoFile(dir: string, relPath: string): Promise<string> {
  return readFile(safeResolve(dir, relPath), "utf-8");
}

export async function writeRepoFile(dir: string, relPath: string, content: string): Promise<void> {
  const abs = safeResolve(dir, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf-8");
}

async function ensureIdentity(git: SimpleGit): Promise<void> {
  const email = (await git.getConfig("user.email")).value;
  if (!email) {
    await git.addConfig("user.email", "mcp-overleaf-server@localhost");
    await git.addConfig("user.name", "MCP Overleaf Server");
  }
}

/** Create-or-checkout a branch in the repo. */
export async function checkoutBranch(dir: string, branch: string): Promise<void> {
  const git = simpleGit(dir);
  const branches = await git.branchLocal();
  if (branches.all.includes(branch)) await git.checkout(branch);
  else await git.checkoutLocalBranch(branch);
}

export interface CommitPushResult {
  committed: boolean;
  pushed: boolean;
  branch: string;
  commit?: string;
  message: string;
}

/** Stage, commit, and optionally push. `files` empty → stage everything. */
export async function commitAndPush(
  dir: string,
  opts: { message: string; files?: string[]; branch?: string; push?: boolean },
): Promise<CommitPushResult> {
  const git = simpleGit(dir);
  await ensureIdentity(git);
  if (opts.branch) await checkoutBranch(dir, opts.branch);

  if (opts.files && opts.files.length > 0) await git.add(opts.files);
  else await git.add(".");

  const status = await git.status();
  const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
  if (status.staged.length === 0 && status.created.length === 0 && status.modified.length === 0) {
    return { committed: false, pushed: false, branch, message: "No changes to commit." };
  }

  const commitSummary = await git.commit(opts.message);
  let pushed = false;
  if (opts.push) {
    await git.push(["-u", "origin", branch]);
    pushed = true;
  }
  return {
    committed: true,
    pushed,
    branch,
    commit: commitSummary.commit,
    message: opts.message,
  };
}
