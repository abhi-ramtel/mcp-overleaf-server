import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JD = "x".repeat(120);

async function getPromptText(name: string, args: Record<string, string>): Promise<string> {
  const transport = new StdioClientTransport({ command: "node", args: ["--import", "tsx", "src/index.ts"], cwd: ROOT });
  const client = new Client({ name: "prompts-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const result = await client.getPrompt({ name, arguments: args });
    return (result.messages[0]!.content as { text: string }).text;
  } finally {
    await client.close();
  }
}

test("tailor_resume: opting out of a cover letter leaves no unconditional claim that one is produced", async () => {
  const text = await getPromptText("tailor_resume", { jobDescription: JD, company: "H", position: "SE", coverLetter: "false" });
  assert.ok(!/produces the résumé and the cover letter/.test(text), "must not assert a letter is produced");
  assert.match(text, /Do NOT pass `coverLetter`/, "must explicitly instruct against passing one");
}, { timeout: 30_000 });

test("tailor_resume: default (no coverLetter arg) instructs producing the letter", async () => {
  const text = await getPromptText("tailor_resume", { jobDescription: JD, company: "H", position: "SE" });
  assert.match(text, /produces the résumé and the cover letter/);
  assert.ok(!/Do NOT pass `coverLetter`/.test(text));
}, { timeout: 30_000 });

test("tailor_multiple_jobs: opting out instructs against passing coverLetter for every job", async () => {
  const text = await getPromptText("tailor_multiple_jobs", { jobs: `Company: H\nPosition: SE\n${JD}`, coverLetter: "false" });
  assert.match(text, /Do NOT give any job a `coverLetter`/);
  assert.ok(!/Also give each job a `coverLetter`/.test(text));
}, { timeout: 30_000 });

test("tailor_multiple_jobs: default instructs giving each job a coverLetter", async () => {
  const text = await getPromptText("tailor_multiple_jobs", { jobs: `Company: H\nPosition: SE\n${JD}` });
  assert.match(text, /Also give each job a `coverLetter`/);
}, { timeout: 30_000 });

test("tailor_multiple_jobs: a source location is sufficient and is read before planning", async () => {
  const text = await getPromptText("tailor_multiple_jobs", { location: "/tmp/jobs.txt" });
  assert.match(text, /Read the job-posting source at `\/tmp\/jobs\.txt` before doing anything else/);
  assert.match(text, /Infer company, position, and URL from each posting/);
  assert.match(text, /four relevant experience entries/);
  assert.match(text, /standard professional font scale/);
});
