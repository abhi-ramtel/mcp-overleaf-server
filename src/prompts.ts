/**
 * MCP prompt (slash command) that turns the whole workflow into one command.
 * Since the reasoning runs in the host model, the "single command" is a prompt
 * that sequences the deterministic tools with exactly one reasoning step in the
 * middle (producing TailoredContent from the brief).
 *
 * Note: MCP prompt arguments are strings, so booleans/enums are passed as text.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "tailor_resume",
    {
      title: "Tailor resume/CV to a job",
      description:
        "One command: tailor your résumé/CV (your local main.tex, or an Overleaf project) to a pasted " +
        "job description — truthfully, from cv.md — compile the PDF, and log it in the tracker.",
      argsSchema: {
        jobDescription: z.string().describe("Paste the full job description"),
        company: z.string().optional(),
        position: z.string().optional(),
        jobUrl: z.string().optional(),
        template: z.string().optional().describe('"resume" (default) or "cv"'),
        project: z.string().optional().describe("Overleaf project URL/id (optional; else uses .env / bundled templates)"),
        push: z.string().optional().describe('"true" to push the tailored .tex back to an Overleaf branch'),
        coverLetter: z.string().optional().describe('"false" to skip the cover letter (default: generate one)'),
      },
    },
    ({ jobDescription, company, position, jobUrl, template, project, push, coverLetter }) => {
      const tpl = template === "cv" ? "cv" : "resume";
      const wantPush = /^(true|yes|1)$/i.test(push ?? "");
      const wantLetter = !/^(false|no|0)$/i.test(coverLetter ?? "");
      const steps: string[] = [];
      let n = 1;
      if (project?.trim()) {
        steps.push(
          `${n++}. Call \`overleaf_sync\` with project="${project.trim()}". If it reports that git access is ` +
            "unavailable, that is NOT an error — just continue with the local templates.",
        );
      } else {
        steps.push(`${n++}. (No Overleaf project — use the local templates, i.e. templates/main.tex.)`);
      }
      steps.push(
        `${n++}. Call \`prepare_tailoring\` with the job description below${company ? `, company="${company}"` : ""}${position ? `, position="${position}"` : ""}${jobUrl ? `, jobUrl="${jobUrl}"` : ""}, template="${tpl}".`,
        `${n++}. Read the brief it returns. Produce ONE valid TailoredContent JSON object: reorder/rewrite/shorten ` +
          "existing bullets to fit the job, keep it to one page, weave in truthful JD keywords, and cite the " +
          "sourceId for every bullet and entry. Do NOT invent anything or add numbers not in the source.",
        `${n++}. Call \`render_and_compile\` with that content, template="${tpl}"${company ? `, company="${company}"` : ""}${position ? `, position="${position}"` : ""}, and the same jobDescription (for ATS coverage).`,
        `${n++}. If it reports provenance warnings or more than one page, revise the JSON and call it again.`,
      );
      if (wantLetter) {
        steps.push(
          `${n++}. Call \`render_cover_letter\` with company${position ? ", position" : ""} and 3-4 tight paragraphs: ` +
            "why this company and role specifically (use details from the posting), the strongest proof from my " +
            "actual experience, and a brief close. Draw only on my master CV — no invented employers, projects, " +
            "or figures. Keep it to one page; revise if it reports more than one page.",
        );
      }
      steps.push(
        `${n++}. Call \`update_tracker\` with company, position${jobUrl ? ", jobLink" : ""}, the ATS score, the resume filename, jdSummary, and status="generated".`,
      );
      if (wantPush) {
        steps.push(
          `${n++}. Call \`overleaf_commit_push\` with project, a message, branch="tailored/${(company || "role").toLowerCase().replace(/[^a-z0-9]+/g, "-")}", and push=true, then put the returned review URL in the tracker's Git Link.`,
        );
      }

      const text = [
        `Tailor my ${tpl}${wantLetter ? " and a matching cover letter" : ""} for this role and log it. ` +
          "Follow these steps exactly, using the MCP tools:",
        "",
        steps.join("\n"),
        "",
        "Reminder: truthfulness beats keyword matching. Only reorder/rewrite/shorten/merge/remove/emphasize " +
          "content that already exists in my master CV.",
        "",
        "--- JOB DESCRIPTION ---",
        jobDescription.trim(),
      ].join("\n");

      return {
        messages: [{ role: "user", content: { type: "text", text } }],
      };
    },
  );
}
