/**
 * MCP tool registrations. The tools are deterministic — the reasoning (analyze
 * JD, rank, rewrite) is done by the host model between prepare_tailoring and
 * render_and_compile. Each handler is wrapped so errors return as tool errors
 * (never throw) and any embedded git token is redacted.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "./config.js";
import { loadMasterCv, runRenderPipeline, latexToText } from "./core/pipeline.js";
import { buildTailoringBrief, masterCvForBrief } from "./core/brief.js";
import { TailoredContentSchema, CoverLetterContentSchema } from "./core/schema.js";
import { runCoverLetterPipeline } from "./core/coverLetter.js";
import { extractKeywords, scoreCoverage, keywordGap } from "./core/keywords.js";
import { recordApplication, listApplications } from "./core/tracker.js";
import { syncRepo, commitAndPush, parseProject, redact, OverleafAccessError } from "./core/overleafGit.js";

// A `type` alias (not `interface`) so it gains an implicit index signature and
// is assignable to the SDK's CallToolResult ({ [x: string]: unknown; ... }).
type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(redact(err instanceof Error ? err.message : String(err)));
  }
}

export function registerTools(server: McpServer): void {
  // 1 ───────────────────────────────────────────── overleaf_sync
  server.registerTool(
    "overleaf_sync",
    {
      title: "Sync Overleaf project",
      description:
        "Optional. Clone (or pull) your Overleaf project via its git repo and list the .tex files. " +
        "Overleaf git access is a premium feature — if it isn't available this returns a normal " +
        "'unavailable' result (NOT an error) and you should simply continue with the local templates. " +
        "The failure is cached so later runs skip the network call entirely.",
      inputSchema: {
        project: z.string().optional().describe("Overleaf project URL or 24-char id"),
        force: z.boolean().optional().describe("Re-check even if a previous attempt was cached as unavailable"),
      },
    },
    async ({ project, force }) =>
      guard(async () => {
        const target = project?.trim() || config.defaultProject;
        if (!target) {
          return ok(
            "Overleaf not configured (no project given and OVERLEAF_PROJECT_URL unset).\n" +
              "→ Continue with the local templates; no action needed.",
          );
        }
        try {
          const r = await syncRepo(target, { force: force ?? false });
          return ok(
            [
              `${r.action === "cloned" ? "Cloned" : "Pulled"} project ${r.projectId} (branch ${r.branch}).`,
              `Local dir: ${r.dir}`,
              `Review online: ${r.webUrl}`,
              r.texFiles.length ? `.tex files:\n  - ${r.texFiles.join("\n  - ")}` : "No .tex files found.",
            ].join("\n"),
          );
        } catch (err) {
          if (err instanceof OverleafAccessError) {
            // Not a failure of the workflow — just no git access on this project.
            return ok(
              [
                `Overleaf git access is unavailable for project ${err.projectId}` +
                  (err.cached ? " (known from a previous check — no network call made)." : "."),
                "This usually means git integration isn't enabled for the project (an Overleaf premium feature).",
                "",
                "→ Falling back to the local templates. Continue the workflow normally;",
                "  render_and_compile will use templates/main.tex as usual.",
                "",
                "If you later enable git access on Overleaf, re-run this tool with force=true.",
              ].join("\n"),
            );
          }
          throw err;
        }
      }),
  );

  // 2 ───────────────────────────────────────────── get_master_cv
  server.registerTool(
    "get_master_cv",
    {
      title: "Get master CV",
      description: "Return the parsed master CV (cv.md) with the stable ids used for tailoring.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const cv = await loadMasterCv();
        return ok(JSON.stringify(masterCvForBrief(cv), null, 2));
      }),
  );

  // 3 ───────────────────────────────────────────── prepare_tailoring
  server.registerTool(
    "prepare_tailoring",
    {
      title: "Prepare tailoring brief",
      description:
        "Return everything YOU (the host model) need to tailor the resume/CV to a job description: " +
        "the master CV with ids, deterministic JD keyword signals, the strict anti-fabrication rules, " +
        "and the exact output schema. After reasoning, call render_and_compile with the TailoredContent JSON.",
      inputSchema: {
        jobDescription: z.string().describe("The full pasted job description"),
        company: z.string().optional(),
        position: z.string().optional(),
        jobUrl: z.string().optional(),
        template: z.enum(["resume", "cv"]).optional().describe("Which document to produce (default resume)"),
      },
    },
    async ({ jobDescription, company, position, jobUrl, template }) =>
      guard(async () => {
        const cv = await loadMasterCv();
        const masterCvText = await readFile(config.cvMasterPath, "utf-8");
        const brief = buildTailoringBrief(cv, {
          jobDescription,
          masterCvText,
          company,
          position,
          jobUrl,
          template,
        });
        return ok(brief);
      }),
  );

  // 4 ───────────────────────────────────────────── render_and_compile
  server.registerTool(
    "render_and_compile",
    {
      title: "Render & compile tailored document",
      description:
        "Inject TailoredContent into the LaTeX template, verify every bullet traces to the master CV " +
        "(anti-fabrication), compile to PDF, and save as <Company>_<Position>.pdf in the output dir. " +
        "Returns provenance warnings and, if jobDescription is given, an ATS coverage report.",
      inputSchema: {
        content: TailoredContentSchema.describe("The tailored content JSON produced from the brief"),
        template: z.enum(["resume", "cv"]).optional(),
        templateFile: z
          .string()
          .optional()
          .describe("Use a specific template .tex instead (absolute, or relative to the synced Overleaf repo)"),
        project: z.string().optional().describe("Overleaf project (needed only if templateFile is repo-relative)"),
        company: z.string().optional(),
        position: z.string().optional(),
        outputName: z.string().optional().describe("Override the output filename base"),
        headerLine: z.string().optional().describe("Custom line under the name, e.g. 'Buffalo, NY | Open to relocation'"),
        jobDescription: z.string().optional().describe("Pass the JD to get an ATS coverage report"),
        compile: z.boolean().optional().describe("Set false to only write .tex without compiling"),
      },
    },
    async (args) =>
      guard(async () => {
        let repoDir: string | undefined;
        if (args.project?.trim()) {
          repoDir = join(config.reposDir, parseProject(args.project).projectId);
        }
        const r = await runRenderPipeline({
          content: args.content,
          template: args.template,
          templateFile: args.templateFile,
          repoDir,
          company: args.company,
          position: args.position,
          outputName: args.outputName,
          headerLine: args.headerLine,
          jobDescription: args.jobDescription,
          compile: args.compile,
        });

        if (!r.ok) return fail(r.error ?? "Render pipeline failed.");

        const lines: string[] = [`✅ Generated ${r.outputBase} from template "${r.templateSource}".`];
        if (r.pdfPath) lines.push(`PDF: ${r.pdfPath}${r.pageCount ? ` (${r.pageCount} page${r.pageCount === 1 ? "" : "s"}, ${r.sizeKB} KB)` : ""}`);
        lines.push(`TeX: ${r.texPath}`);
        if (r.pageCount && r.pageCount > 1) {
          lines.push(`⚠️  ${r.pageCount} pages — trim bullets/entries to fit one page.`);
        }
        if (r.provenance.warnings.length) {
          lines.push("", "Provenance warnings (review before sending):", ...r.provenance.warnings.map((w) => `  • ${w}`));
        }
        if (r.validation?.warnings.length) {
          lines.push("", "LaTeX warnings:", ...r.validation.warnings.map((w) => `  • ${w}`));
        }
        if (r.ats) {
          lines.push(
            "",
            `ATS keyword coverage: ${r.ats.percent}%`,
            r.ats.missing.length ? `Missing keywords: ${r.ats.missing.join(", ")}` : "All JD keywords covered.",
            r.ats.gap.addable.length ? `↳ Truthfully addable (in your CV): ${r.ats.gap.addable.join(", ")}` : "",
            r.ats.gap.absent.length ? `↳ Not in your CV (do not add): ${r.ats.gap.absent.join(", ")}` : "",
          );
        }
        return ok(lines.filter((l) => l !== undefined).join("\n"));
      }),
  );

  // 4b ──────────────────────────────────────────── render_cover_letter
  server.registerTool(
    "render_cover_letter",
    {
      title: "Render & compile a one-page cover letter",
      description:
        "Compile a one-page cover letter styled to match the résumé, saved as " +
        "<Company>_<Position>_CoverLetter.pdf. Write 3-4 tight paragraphs drawn only from the master CV: " +
        "why this company/role, the most relevant proof from your experience, and a close. " +
        "Never invent employers, projects, or figures — quantitative claims not found in cv.md are flagged.",
      inputSchema: {
        content: CoverLetterContentSchema.describe("The cover letter content"),
        templateFile: z.string().optional().describe("Override the letter template"),
        outputName: z.string().optional().describe("Override the output filename base"),
        compile: z.boolean().optional().describe("Set false to write .tex only"),
      },
    },
    async (args) =>
      guard(async () => {
        const r = await runCoverLetterPipeline({
          content: args.content,
          templateFile: args.templateFile,
          outputName: args.outputName,
          compile: args.compile,
        });
        if (!r.ok) return fail(r.error ?? "Cover letter pipeline failed.");

        const lines = [`✅ Generated ${r.outputBase}.`];
        if (r.pdfPath) {
          lines.push(`PDF: ${r.pdfPath}${r.pageCount ? ` (${r.pageCount} page${r.pageCount === 1 ? "" : "s"}, ${r.sizeKB} KB)` : ""}`);
        }
        lines.push(`TeX: ${r.texPath}`);
        if ((r.pageCount ?? 1) > 1) {
          lines.push(`⚠️  ${r.pageCount} pages — a cover letter should be one page; shorten the paragraphs.`);
        }
        if (r.claims.warnings.length) {
          lines.push("", "Claim warnings (verify before sending):", ...r.claims.warnings.map((w) => `  • ${w}`));
        }
        return ok(lines.join("\n"));
      }),
  );

  // 5 ───────────────────────────────────────────── ats_report
  server.registerTool(
    "ats_report",
    {
      title: "ATS keyword report",
      description:
        "Score how well a resume covers a job description's keywords, and split the gap into truthfully " +
        "addable (already in your CV) vs. absent. Provide resumeText or a texPath.",
      inputSchema: {
        jobDescription: z.string(),
        texPath: z.string().optional().describe("Path to a rendered .tex (converted to text)"),
        resumeText: z.string().optional().describe("Plain resume text (alternative to texPath)"),
      },
    },
    async ({ jobDescription, texPath, resumeText }) =>
      guard(async () => {
        let text = resumeText ?? "";
        if (!text && texPath) {
          if (!existsSync(texPath)) return fail(`texPath not found: ${texPath}`);
          text = latexToText(await readFile(texPath, "utf-8"));
        }
        if (!text) return fail("Provide resumeText or texPath.");
        const keywords = extractKeywords(jobDescription);
        const cov = scoreCoverage(keywords, text);
        const masterText = await readFile(config.cvMasterPath, "utf-8");
        const gap = keywordGap(keywords, text, masterText);
        return ok(
          [
            `ATS keyword coverage: ${cov.percent}% (${cov.matched.length}/${keywords.length})`,
            `Matched: ${cov.matched.join(", ") || "(none)"}`,
            `Missing: ${cov.missing.join(", ") || "(none)"}`,
            `Addable (in your CV, safe to surface): ${gap.addable.join(", ") || "(none)"}`,
            `Absent (not in your CV, would be fabrication): ${gap.absent.join(", ") || "(none)"}`,
          ].join("\n"),
        );
      }),
  );

  // 6 ───────────────────────────────────────────── update_tracker
  server.registerTool(
    "update_tracker",
    {
      title: "Update application tracker",
      description:
        "Add or update a row in the application tracker sheet (output/applications.csv). " +
        "Upserts on company+position so regenerating doesn't duplicate.",
      inputSchema: {
        company: z.string(),
        position: z.string(),
        jobLink: z.string().optional(),
        atsScore: z.union([z.number(), z.string()]).optional(),
        resumeFile: z.string().optional(),
        gitLink: z.string().optional(),
        jdSummary: z.string().optional(),
        status: z.string().optional().describe("generated | applied | interview | offer | rejected"),
        notes: z.string().optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const res = await recordApplication(config.trackerPath, args);
        return ok(
          `${res.created ? "Added" : "Updated"} ${args.company} — ${args.position} in the tracker (${res.total} total).\nSheet: ${config.trackerPath}`,
        );
      }),
  );

  // 7 ───────────────────────────────────────────── list_applications
  server.registerTool(
    "list_applications",
    {
      title: "List tracked applications",
      description: "Return all rows from the application tracker sheet.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const rows = await listApplications(config.trackerPath);
        if (rows.length === 0) return ok("No applications tracked yet.");
        const table = rows
          .map((r) => `${r.dateApplied} | ${r.company} — ${r.position} | ATS ${r.atsScore || "-"}% | ${r.status || "-"} | ${r.resumeFile || "-"}`)
          .join("\n");
        return ok(`${rows.length} application(s):\n${table}\n\nSheet: ${config.trackerPath}`);
      }),
  );

  // 8 ───────────────────────────────────────────── overleaf_commit_push
  server.registerTool(
    "overleaf_commit_push",
    {
      title: "Commit (and optionally push) to Overleaf",
      description:
        "Commit changes in the synced Overleaf repo, optionally to a branch, and push back to Overleaf. " +
        "Pushing publishes to your Overleaf project — set push=true only when you intend that.",
      inputSchema: {
        project: z.string().optional(),
        message: z.string().describe("Commit message"),
        files: z.array(z.string()).optional().describe("Specific files to stage (default: all changes)"),
        branch: z.string().optional().describe("Create/switch to this branch before committing"),
        push: z.boolean().optional().describe("Push to Overleaf (default false)"),
      },
    },
    async ({ project, message, files, branch, push }) =>
      guard(async () => {
        const target = project?.trim() || config.defaultProject;
        if (!target) return fail("No project given and OVERLEAF_PROJECT_URL is not set.");
        const { projectId, webUrl } = parseProject(target);
        const dir = join(config.reposDir, projectId);
        if (!existsSync(join(dir, ".git"))) return fail("Project not synced. Run overleaf_sync first.");

        const r = await commitAndPush(dir, {
          message,
          files: files ?? [],
          branch: branch ?? "",
          push: push ?? false,
        });
        if (!r.committed) return ok(r.message);
        return ok(
          [
            `Committed to branch ${r.branch}${r.commit ? ` (${r.commit.slice(0, 8)})` : ""}: ${r.message}`,
            r.pushed ? `Pushed to Overleaf. Review: ${webUrl}` : "Not pushed (push=false). Set push=true to publish to Overleaf.",
          ].join("\n"),
        );
      }),
  );
}
