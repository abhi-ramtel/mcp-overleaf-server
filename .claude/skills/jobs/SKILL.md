---
name: jobs
description: Collect several job postings through an in-chat form, then tailor a résumé and cover letter for each one. Use when the user wants to apply to more than one job at once, mentions a batch of jobs, asks for a job entry form, or says something like "I have 4 jobs to apply to".
argument-hint: "[number of jobs]"
allowed-tools: mcp__visualize__read_me, mcp__visualize__show_widget, mcp__overleaf-resume__batch_plan, mcp__overleaf-resume__batch_render, mcp__overleaf-resume__get_master_cv, Read
---

# Multi-job entry

Replaces hand-writing a jobs JSON. Ask how many jobs, render that many entry cards
as a form in the chat, then run the existing batch pipeline on what comes back.

`$ARGUMENTS` may already contain the job count (e.g. `/jobs 4`).

## Step 0 — infer before asking

Skip any question you can already answer:

- A number in `$ARGUMENTS` or in the user's message ("I have 3 jobs") → that's the count, skip step 1.
- Job postings already pasted in this conversation, attached as files, or referenced by a readable local path/URL → skip straight to step 3. Read the source first; do not make the user paste it again.
- `job.json` in the repo root filled in with real values → offer to use it instead of the form.

Never ask for something the conversation already told you.

## Step 1 — how many jobs

Call `mcp__visualize__read_me` with `modules: ["elicitation"]` first — it carries the
canonical form chrome and the current design rules. Then render **form 1** from
[forms.md](forms.md) with `mcp__visualize__show_widget`.

It asks three things at once: job count (1–30), résumé vs CV, and cover letters.
Stop and wait for the reply — it arrives as the user's next message.

## Step 2 — the job cards

Render **form 2** from [forms.md](forms.md), repeating the job block exactly `N`
times with the index incremented. Only include the per-job cover-letter pills when
step 1 answered "let me pick per job".

Cap at 30 (`MAX_PLAN_JOBS` in `src/core/batch.ts`). If more are wanted, run the
first 30 and say so. Above ~8 jobs the form gets long — render it anyway rather
than splitting it; the batch itself is chunked later.

## Step 3 — parse the reply

The submitted answers arrive as one line of `Label: value` pairs, with any value
over 200 characters replaced by `(N chars — see below)` and repeated verbatim under
a `--- Full content ---` fold. **Read the fold** — that's where the job descriptions are.

Build a list of `{ company, position, jobDescription, jobUrl, questions }`:

- `Job N posting` → `jobDescription`. Required. Drop any job whose posting is blank and say which.
- `Job N company` / `Job N role` → if blank, **read them out of the posting text**. They are
  almost always in the first lines. Say what you inferred so it can be corrected.
- `Job N link` → `jobUrl`, omit if blank.
- `Job N questions` → split on newlines into `questions`, omit if blank.

If the user skipped the form (`(Skipped the form — …)`), don't re-render it — ask for
the postings in plain text, `---` separated, and carry on.

## Step 4 — run the batch

This is the credit-efficient path; don't write content per job blindly.

1. `batch_plan` **once** with the whole parsed list and the chosen template. It skips
   jobs already in the tracker, clusters similar roles, checks the cross-session cache,
   and splits the remaining work into chunks of three — one `batch_render` call each.
2. Write `TailoredContent` JSON **only** for the jobs marked GENERATE. Cite a
   `sourceId` for every bullet and entry. Fill the page naturally: three bullets per
   experience entry, four relevant experience entries when the master CV contains
   them, and three sourced bullets for the two or three projects most relevant to the
   role (at least two for every other project). Keep top-level skill category labels
   and items close to the master CV; do not invent JD-derived labels or skills. Keep
   the template's standard professional font scale, margins, and visual design — add
   evidence instead of shrinking the page. Only trim when a render reports more than
   one page.
3. `batch_render` **once per chunk**, in the plan's order, waiting for each call to
   return before starting the next — `content` for that chunk's generated jobs,
   `reuseFrom` copied verbatim from the plan for the rest. Include a `coverLetter` per
   job unless letters were opted out; reuse proof points across similar roles and vary
   the company-specific opening. Compiling, logging, and caching happen inside each call.

**Never merge chunks into one call.** A long call is what times the server out, and
that is the whole reason the plan hands back groups of three.

Truthfulness beats keyword matching: only reorder, rewrite, shorten, merge, remove,
or emphasize content that already exists in the master CV. Invent nothing.

## Edge cases

The server handles these; follow it rather than working around it.

- **Already applied.** A job whose résumé is already in `output/applications.csv` (and
  still on disk) is skipped, not regenerated. Say so in the report. Only pass
  `force: true` when the user explicitly asks to redo one.
- **Resuming.** Re-submitting the same list after a crash or a partial run is safe —
  finished jobs skip themselves, so only the gaps get built.
- **A chunk fails.** Fix and re-send just that job, then carry on with the next chunk.
  Never restart the whole batch.
- **Duplicates, blank companies, stub postings.** The plan skips them with a reason
  instead of failing. Relay the reason and ask for what's missing.
- **A reuse job errors with "no cached content".** The cache was cleared between plan
  and render — re-run `batch_plan` for the remaining jobs, or write content for that
  one job.
- **More than 30 jobs.** Run the first 30, report the rest, and offer a second pass.

## Step 5 — report

A short table: company, position, pages, ATS %, and generated / reused / skipped
(already done). Revise only the jobs that came back with warnings or more than one page.

Then answer any application questions **in chat**, grouped under each company —
first person, 3–6 sentences, grounded only in the master CV, concrete about that
company and role. They never go into a document.

## If the form can't render

`mcp__visualize__show_widget` isn't available in every client (plain CLI, other MCP
hosts). If it's missing or errors, fall back without ceremony:

- `AskUserQuestion` for the count, template, and cover-letter choice.
- Then ask for the postings as `---` separated blocks, one message, `Company:`,
  `Position:`, `Job URL:` and `Question:` lines optional.

Same steps 3–5 from there. The MCP prompt
`/mcp__overleaf-resume__tailor_multiple_jobs` accepts that same block format.
