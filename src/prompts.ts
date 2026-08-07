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
        template: z.string().optional().describe('"resume" (default) or "cv" when templates/cv.tex exists'),
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
        `${n++}. Read the brief it returns. Produce ONE valid TailoredContent JSON object: reorder/rewrite ` +
          "existing bullets to fit the job, weave in truthful JD keywords, and cite the sourceId for every " +
          "bullet and entry. Do NOT invent anything or add numbers not in the source. " +
          "FILL THE PAGE NATURALLY: give every experience entry THREE bullets, include four relevant " +
          "experience entries when my master CV has them, and give the two or three most relevant projects " +
          "THREE sourced bullets (at least two for every other project). Keep top-level skill category labels " +
          "and skill items close to the master CV; do not create new labels or JD-derived skills. Preserve the " +
          "template's standard professional type scale and margins — add useful evidence instead of shrinking " +
          "the design. A one-page résumé with whitespace at the bottom is a wasted page — only trim if the " +
          "render reports 2+ pages.",
        `${n++}. Call \`render_and_compile\` ONCE with that content, template="${tpl}"${company ? `, company="${company}"` : ""}${position ? `, position="${position}"` : ""}${jobUrl ? `, jobUrl="${jobUrl}"` : ""}, and the same jobDescription (for ATS coverage).` +
          (wantLetter
            ? " In the SAME call also pass `coverLetter` with 3-4 tight paragraphs: why this company and role " +
              "specifically (use details from the posting), the strongest proof from my actual experience, and a " +
              "brief close — drawn only from my master CV, no invented employers, projects, or figures. This " +
              "produces the résumé and the matching letter together."
            : ""),
        `${n++}. That single call produces the résumé${wantLetter ? " and the cover letter" : ""} from my own ` +
          "templates/main.tex, and logs the application automatically — no separate update_tracker call, and " +
          "does not generate a separate CV. If the result reports provenance warnings, more than one page, or " +
          "that the PAGE IS UNDER-FILLED, revise the content and call it again." +
          (wantLetter
            ? ""
            : " Do NOT pass `coverLetter` to render_and_compile — I opted out of a cover letter for this job."),
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
        "Batch mode: tailor up to 30 jobs in one go. Skips jobs already in the tracker, clusters similar " +
        "roles so you only reason once per role family, and renders three jobs per call so nothing times out.",
      argsSchema: {
        jobs: z
          .string()
          .optional()
          .describe(
            'The jobs. Either JSON [{"company","position","jobDescription","jobUrl","questions"}] or blocks ' +
              'separated by a line of "---", each with "Company:", "Position:", optional "Question:" lines, ' +
              "then the job description.",
          ),
        location: z
          .string()
          .optional()
          .describe(
            "Optional local file path, attachment, or URL containing the job postings. The host model reads it, " +
              "infers job details, and follows the same batch workflow; use this when you only want to provide a location.",
          ),
        template: z.string().optional().describe('"resume" (default) or "cv" when templates/cv.tex exists'),
        coverLetter: z.string().optional().describe('"false" to skip cover letters (default: one per job)'),
      },
    },
    ({ jobs, location, template, coverLetter }) => {
      const tpl = template === "cv" ? "cv" : "resume";
      // Default ON, matching the documented behaviour and the single-job prompt.
      const wantLetter = !/^(false|no|0)$/i.test(coverLetter ?? "");
      const inlineJobs = jobs?.trim();
      const sourceLocation = location?.trim();

      const text = [
        `Tailor my ${tpl} for each of the jobs below (max 30). Be economical: do NOT write content for every ` +
          "job independently — follow this exactly:",
        "",
        sourceLocation
          ? `0. Read the job-posting source at \`${sourceLocation}\` before doing anything else. It may be a local ` +
            "file, attachment, or URL; use the client’s available file or web capability to read it. Do not ask me " +
            "to copy its contents into chat. If it cannot be read, report the exact access problem and stop rather " +
            "than guessing."
          : "",
        `1. Parse the source${inlineJobs ? " and the inline jobs below" : ""} into a list of { company, position, ` +
          "jobDescription, jobUrl, questions }. Infer company, position, and URL from each posting when they are " +
          "not explicitly labeled. For text blocks, a line of \"---\" separates jobs; lines beginning \"Company:\", " +
          '"Position:", "Job URL:" and "Question:" are fields (collect every Question line into the `questions` ' +
          "array), and the remaining text is the job description. Cap at 30; if more are given, run the first 30 " +
          "and say so.",
        `2. Call \`batch_plan\` ONCE with the whole list and template="${tpl}". It skips jobs I have already ` +
          "applied to, clusters similar roles, checks the cache, and splits what is left into chunks of three — " +
          "one `batch_render` call each. Do not second-guess it: the jobs it marks SKIPPED are done, and its " +
          "chunk boundaries exist so a single call cannot time out.",
        "3. Write TailoredContent JSON ONLY for the jobs it marks GENERATE. Do not write content for the " +
          "others — the server resolves theirs automatically. Cite a sourceId for every bullet and entry, and " +
          "FILL THE PAGE NATURALLY: three bullets per experience entry, four relevant experience entries when " +
          "the master CV provides them, and three sourced bullets for the two or three most role-relevant " +
          "projects (at least two per other project). Keep top-level skill category labels and items close to the " +
          "master CV, never inventing JD-derived labels or skills. Preserve the template's standard professional " +
          "font scale, margins, and visual design; improve density with meaningful evidence, not compressed type. " +
          "Only trim if a render reports more than one page.",
        "4. Call `batch_render` ONCE PER CHUNK, in the plan's order, waiting for each call to return before " +
          "starting the next. Never merge chunks into one call. In each call pass `content` for that chunk's " +
          "GENERATE jobs and `reuseFrom` exactly as the plan printed it for the rest (an index inside that same " +
          "call, or a cache key). Every job is compiled and logged to the tracker automatically — no separate " +
          "update_tracker calls needed." +
          (wantLetter
            ? " Also give each job a `coverLetter` in the same call so the letters are produced alongside the " +
              "résumés; reuse the same proof points across similar roles and vary only the company-specific opening."
            : " Do NOT give any job a `coverLetter` — cover letters were opted out of for this batch."),
        "5. If a chunk reports a failure, fix and re-send just that job, then carry on with the next chunk — " +
          "anything already rendered is skipped automatically, so nothing gets duplicated or overwritten. " +
          "Never restart the whole batch because of one bad job.",
        "6. Report a short table when every chunk is done: company, position, pages, ATS %, and whether it was " +
          "generated, reused, or skipped as already done. Only revise jobs that came back with warnings or more " +
          "than one page.",
        "7. If any job had application questions, answer them IN CHAT at the end, grouped under each company " +
          "heading. First person, 3-6 sentences each, grounded only in my master CV and referencing that " +
          "company and role concretely. These do not go in any document.",
        "",
        "Reminder: truthfulness beats keyword matching. Only reorder/rewrite/shorten/merge/remove/emphasize " +
          "content that already exists in my master CV.",
        ...(sourceLocation ? ["", "--- JOB SOURCE LOCATION ---", sourceLocation] : []),
        ...(inlineJobs ? ["", "--- INLINE JOBS ---", inlineJobs] : []),
        ...(!sourceLocation && !inlineJobs
          ? ["", "No jobs or location were supplied. Ask me for one before running the batch."]
          : []),
      ]
        .filter(Boolean)
        .join("\n");

      return { messages: [{ role: "user", content: { type: "text", text } }] };
    },
  );
}
