import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.overleafToken is a plain value computed once when config.ts loads, not
// a live getter — and static imports are hoisted above a module's own top-level
// statements, so a `process.env... ??=` placed after a static import of
// overleafGit.js (which transitively imports config.js) runs too late to have
// any effect. Set the env var first, then dynamically import so the module
// graph loads afterward and actually observes it.
process.env.OL_GIT_AUTHENTICATION_TOKEN ??= "olp_testtoken";
const { parseProject, safeResolve, redact, listTexFiles } = await import("../src/core/overleafGit.js");

test("parseProject accepts a full URL and a bare id", () => {
  const fromUrl = parseProject("https://www.overleaf.com/project/6a309c9641ac036f96aa4e9f");
  assert.equal(fromUrl.projectId, "6a309c9641ac036f96aa4e9f");
  assert.match(fromUrl.gitUrl, /^https:\/\/git:.+@git\.overleaf\.com\/6a309c9641ac036f96aa4e9f$/);
  assert.equal(fromUrl.webUrl, "https://www.overleaf.com/project/6a309c9641ac036f96aa4e9f");

  const fromId = parseProject("6a309c9641ac036f96aa4e9f");
  assert.equal(fromId.projectId, "6a309c9641ac036f96aa4e9f");
});

test("parseProject rejects garbage", () => {
  assert.throws(() => parseProject("not-a-project"), /valid Overleaf project id/);
  assert.throws(() => parseProject(""), /No Overleaf project/);
});

test("redact hides the token in a git URL", () => {
  const url = "https://git:olp_supersecret@git.overleaf.com/abc";
  assert.equal(redact(url), "https://git:***@git.overleaf.com/abc");
});

test("safeResolve blocks path traversal", () => {
  const repo = "/tmp/repo";
  assert.equal(safeResolve(repo, "main.tex"), "/tmp/repo/main.tex");
  assert.equal(safeResolve(repo, "sections/exp.tex"), "/tmp/repo/sections/exp.tex");
  assert.throws(() => safeResolve(repo, "../secret"), /escapes the repository/);
  assert.throws(() => safeResolve(repo, "/etc/passwd"), /escapes the repository/);
});

test("listTexFiles finds .tex recursively and skips .git", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-repo-"));
  try {
    await writeFile(join(dir, "main.tex"), "x");
    await mkdir(join(dir, "sections"), { recursive: true });
    await writeFile(join(dir, "sections", "exp.tex"), "x");
    await writeFile(join(dir, "notes.md"), "x");
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "config.tex"), "x"); // must be ignored

    const files = await listTexFiles(dir);
    assert.deepEqual(files, ["main.tex", "sections/exp.tex"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
