# Form templates

Pass these to `mcp__visualize__show_widget` as `widget_code`. The shell wires
selection, the "Other" reveal, and submit — emit **no** `<script>` and **no**
`onclick`. Every `.elicit-pill` needs a clean `data-value`; every free-text control
needs a unique `data-name`.

The header `<svg>` below is fixed chrome. If `read_me` (module `elicitation`) shows a
different canonical path, use that one instead — it is the source of truth.

---

## Form 1 — batch settings

`title: batch_settings`

```html
<form class="elicit">
  <div class="elicit-header">
    <svg viewBox="0 0 20 20" fill="currentColor"><path d="M11.586 2a1.5 1.5 0 0 1 1.06.44l2.914 2.914a1.5 1.5 0 0 1 .44 1.06V16.5a1.5 1.5 0 0 1-1.5 1.5h-9a1.5 1.5 0 0 1-1.492-1.347L4 16.5v-13A1.5 1.5 0 0 1 5.5 2zM5.5 3a.5.5 0 0 0-.5.5v13a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V7h-2.5A1.5 1.5 0 0 1 11 5.5V3zm7.04 10.304a.5.5 0 0 1 .92.392c-.295.69-.871 1.304-1.66 1.304-.487 0-.892-.234-1.2-.574-.309.34-.713.574-1.2.574-.486 0-.892-.233-1.2-.574-.31.34-.714.574-1.2.574a.5.5 0 0 1 0-1c.212 0 .52-.18.74-.696l.034-.067a.5.5 0 0 1 .886.067c.221.516.528.696.74.696.213 0 .52-.18.74-.696l.035-.067a.5.5 0 0 1 .885.067c.22.516.527.696.74.696s.519-.18.74-.696m0-4a.5.5 0 0 1 .92.392c-.295.69-.871 1.304-1.66 1.304-.487 0-.892-.234-1.2-.574-.309.34-.713.574-1.2.574-.486 0-.892-.233-1.2-.574-.31.34-.714.574-1.2.574a.5.5 0 0 1 0-1c.212 0 .52-.18.74-.696l.034-.067a.5.5 0 0 1 .886.067c.221.516.528.696.74.696.213 0 .52-.18.74-.696l.035-.067a.5.5 0 0 1 .885.067c.22.516.527.696.74.696s.519-.18.74-.696M12 5.5a.5.5 0 0 0 .5.5h2.293L12 3.207z"/></svg>
    <span>Batch details</span>
  </div>
  <div class="elicit-body">
    <div class="elicit-group">
      <label class="elicit-question">How many jobs are we doing?</label>
      <div class="elicit-pills" data-name="count" data-multi="false">
        <button type="button" class="elicit-pill" data-value="1">1</button>
        <button type="button" class="elicit-pill" data-value="2">2</button>
        <button type="button" class="elicit-pill" data-value="3">3</button>
        <button type="button" class="elicit-pill" data-value="4">4</button>
        <button type="button" class="elicit-pill" data-value="5">5</button>
        <button type="button" class="elicit-pill" data-value="6">6</button>
        <button type="button" class="elicit-pill" data-value="more" data-other>More</button>
      </div>
      <input type="text" class="elicit-other" data-for="count" placeholder="How many? (up to 10)" hidden>
    </div>
    <div class="elicit-group">
      <label class="elicit-question">Which document should I tailor?</label>
      <div class="elicit-pills" data-name="template" data-multi="false">
        <button type="button" class="elicit-pill" data-value="resume"
          style="border-radius:12px; padding:14px 16px; display:flex; gap:12px; align-items:flex-start; text-align:left; min-width:190px; box-shadow:0 1px 2px rgba(0,0,0,0.04)">
          <i class="ti ti-file-text" style="font-size:20px" aria-hidden="true"></i>
          <span>
            <span style="font-size:13px; font-weight:500">Résumé</span><br>
            <span style="font-size:11px; color:var(--text-muted)">One page, the usual</span>
          </span>
        </button>
        <button type="button" class="elicit-pill" data-value="cv"
          style="border-radius:12px; padding:14px 16px; display:flex; gap:12px; align-items:flex-start; text-align:left; min-width:190px; box-shadow:0 1px 2px rgba(0,0,0,0.04)">
          <i class="ti ti-files" style="font-size:20px" aria-hidden="true"></i>
          <span>
            <span style="font-size:13px; font-weight:500">Full CV</span><br>
            <span style="font-size:11px; color:var(--text-muted)">Needs templates/cv.tex</span>
          </span>
        </button>
      </div>
    </div>
    <div class="elicit-group">
      <label class="elicit-question">Cover letters?</label>
      <div class="elicit-pills" data-name="letters" data-multi="false">
        <button type="button" class="elicit-pill" data-value="all">Yes, every job</button>
        <button type="button" class="elicit-pill" data-value="none">No letters</button>
        <button type="button" class="elicit-pill" data-value="per_job">Let me pick per job</button>
      </div>
    </div>
  </div>
  <div class="elicit-footer">
    <button type="button" class="elicit-skip">Skip</button>
    <button type="button" class="elicit-submit">Continue</button>
  </div>
</form>
```

---

## Form 2 — the job cards

`title: job_entries`

Emit the header, then repeat the `.elicit-group` block below once per job with `1`
replaced by the job number throughout (`data-name`, the label, the placeholders).
Header span reads `N jobs` — e.g. `<span>4 jobs</span>`.

Include the trailing cover-letter pills **only** when form 1 answered `per_job`.

```html
<div class="elicit-group">
  <label class="elicit-question">Job 1</label>
  <textarea class="elicit-textarea" data-name="job_1_company" rows="1"
    placeholder="Company — leave blank and I'll read it off the posting"></textarea>
  <textarea class="elicit-textarea" data-name="job_1_role" rows="1"
    placeholder="Role title — leave blank and I'll read it off the posting"></textarea>
  <textarea class="elicit-textarea" data-name="job_1_link" rows="1"
    placeholder="Job URL (optional)"></textarea>
  <textarea class="elicit-textarea" data-name="job_1_posting" rows="8"
    placeholder="Paste the full job description"></textarea>
  <textarea class="elicit-textarea" data-name="job_1_questions" rows="2"
    placeholder="Application questions, one per line (optional)"></textarea>
  <div class="elicit-pills" data-name="job_1_letter" data-multi="false">
    <button type="button" class="elicit-pill" data-value="yes">Cover letter</button>
    <button type="button" class="elicit-pill" data-value="no">Résumé only</button>
  </div>
</div>
```

Footer, once, after the last job group:

```html
  </div>
  <div class="elicit-footer">
    <button type="button" class="elicit-skip">Skip</button>
    <button type="button" class="elicit-submit">Tailor them</button>
  </div>
</form>
```

## Reading the reply

Labels come back humanized: `job_1_posting` → `Job 1 posting`. Anything over 200
characters shows as `(N chars — see below)` on the summary line and appears verbatim,
newlines intact, under `--- Full content ---`. The postings live there — read that
section, not the summary line.
