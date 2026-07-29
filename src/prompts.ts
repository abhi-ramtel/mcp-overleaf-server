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
        questions: z
          .string()
          .optional()
          .describe("Application-portal questions, one per line — answered in chat, not in any document"),
        template: z.string().optional().describe('"resume" (default) or "cv"'),
        project: z.string().optional().describe("Overleaf project URL/id (optional; else uses .env / bundled templates)"),
        push: z.string().optional().describe('"true" to push the tailored .tex back to an Overleaf branch'),
        coverLetter: z.string().optional().describe('"false" to skip the cover letter (default: generate one)'),
      },
    },
    ({ jobDescription, company, position, jobUrl, questions, template, project, push, coverLetter }) => {
      const questionList = (questions ?? "")
        .split("\n")
        .map((q) => q.trim())
        .filter(Boolean);
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
        `${n++}. Call \`prepare_tailoring\` with the job description below${company ? `, company="${company}"` : ""}${position ? `, position="${position}"` : ""}${jobUrl ? `, jobUrl="${jobUrl}"` : ""}, template="${tpl}"` +
          (questionList.length ? `, and questions=${JSON.stringify(questionList)}` : "") +
          ".",
        `${n++}. Read the brief it returns. Produce ONE valid TailoredContent JSON object: reorder/rewrite/shorten ` +
          "existing bullets to fit the job, keep it to one page, weave in truthful JD keywords, and cite the " +
          "sourceId for every bullet and entry. Do NOT invent anything or add numbers not in the source.",
        `${n++}. Call \`render_and_compile\` ONCE with that content, template="${tpl}"${company ? `, company="${company}"` : ""}${position ? `, position="${position}"` : ""}${jobUrl ? `, jobUrl="${jobUrl}"` : ""}, and the same jobDescription (for ATS coverage).` +
          (wantLetter
            ? " In the SAME call also pass `coverLetter` with 3-4 tight paragraphs: why this company and role " +
              "specifically (use details from the posting), the strongest proof from my actual experience, and a " +
              "brief close — drawn only from my master CV, no invented employers, projects, or figures. This " +
              "produces the résumé and the matching letter together."
            : ""),
        `${n++}. That single call produces the résumé, the CV, and the cover letter, and logs the application ` +
          "to the tracker automatically — no separate update_tracker call is needed. If the result reports " +
          "provenance warnings, more than one page, or a cover-letter warning, revise and call it again.",
      );
      if (questionList.length) {
        steps.push(
          `${n++}. Finally, answer the application questions IN CHAT (they do not go in any document). ` +
            "First person, 3-6 sentences each, grounded only in my master CV, referencing this company and " +
            "role concretely. If a question can't be answered truthfully from my CV, say so and tell me what " +
            "you'd need from me.",
        );
      }
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
        ...(questionList.length
          ? ["", "--- APPLICATION QUESTIONS ---", ...questionList.map((q, i) => `${i + 1}. ${q}`)]
          : []),
        "",
        "--- JOB DESCRIPTION ---",
        jobDescription.trim(),
      ].join("\n");

      return {
        messages: [{ role: "user", content: { type: "text", text } }],
      };
    },
  );

  // ── Multi-job batch ────────────────────────────────────────────────────────
  server.registerPrompt(
    "tailor_multiple_jobs",
    {
      title: "Tailor résumés for several jobs at once",
      description:
        "Batch mode: tailor up to 10 jobs in one go. Clusters similar roles and reuses cached work so " +
        "you only reason once per role family instead of once per job.",
      argsSchema: {
        jobs: z
          .string()
          .describe(
            'The jobs. Either JSON [{"company","position","jobDescription","jobUrl","questions"}] or blocks ' +
              'separated by a line of "---", each with "Company:", "Position:", optional "Question:" lines, ' +
              "then the job description.",
          ),
        template: z.string().optional().describe('"resume" (default) or "cv"'),
        coverLetter: z.string().optional().describe('"false" to skip cover letters (default: one per job)'),
      },
    },
    ({ jobs, template, coverLetter }) => {
      const tpl = template === "cv" ? "cv" : "resume";
      const wantLetter = /^(true|yes|1)$/i.test(coverLetter ?? "");

      const text = [
        `Tailor my ${tpl} for each of the jobs below (max 10). Be economical: do NOT write content for every ` +
          "job independently — follow this exactly:",
        "",
        `1. Parse the jobs into a list of { company, position, jobDescription, jobUrl, questions }. Blocks are ` +
          'separated by "---"; lines beginning "Company:", "Position:", "Job URL:" and "Question:" are fields ' +
          "(collect every Question line into the `questions` array), and the remaining text is the job " +
          "description. Cap at 10; if more are given, use the first 10 and say so.",
        `2. Call \`batch_plan\` with that list and template="${tpl}". It deterministically clusters similar roles ` +
          "and checks the cache, then returns the exact indices that need fresh content.",
        "3. Write TailoredContent JSON ONLY for the indices it marks GENERATE. Do not write content for the " +
          "others — the server resolves theirs automatically. Keep each to one page and cite a sourceId for " +
          "every bullet and entry.",
        "4. Call `batch_render` ONCE with all jobs: pass `content` for the generated ones, and `reuseFrom` " +
          "(the index or cache key from the plan) for the rest. Every job is compiled and logged to the " +
          "tracker automatically — no separate update_tracker calls needed." +
          (wantLetter
            ? " Also give each job a `coverLetter` in the same call so the letters are produced alongside the " +
              "résumés; reuse the same proof points across similar roles and vary only the company-specific opening."
            : ""),
        "5. Report a short table: company, position, pages, ATS %, and whether it was generated or reused. " +
          "Only revise jobs that came back with warnings or more than one page.",
        "6. If any job had application questions, answer them IN CHAT at the end, grouped under each company " +
          "heading. First person, 3-6 sentences each, grounded only in my master CV and referencing that " +
          "company and role concretely. These do not go in any document.",
        "",
        "Reminder: truthfulness beats keyword matching. Only reorder/rewrite/shorten/merge/remove/emphasize " +
          "content that already exists in my master CV.",
        "",
        "--- JOBS ---",
        jobs.trim(),
      ]
        .filter(Boolean)
        .join("\n");

      return { messages: [{ role: "user", content: { type: "text", text } }] };
    },
  );
}
