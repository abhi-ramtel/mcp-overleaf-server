# Template authoring guide

Templates are plain LaTeX with `{{PLACEHOLDER}}` tokens. `src/core/latexRenderer.ts`
fills every token; anything it doesn't recognize is left intact so the validator
can flag it. Add or restyle macros freely — **keep the placeholders and the four
`\resume*` macros** the renderer emits into.

## Placeholders the renderer fills

| Placeholder | Filled with |
|---|---|
| `{{NAME}}` | `contact.name` from cv.md |
| `{{CONTACT_LINE}}` | small line under the name (phone + portfolio, or `headerLine` override) |
| `{{SUMMARY}}` | tailored summary (resume template only) |
| `{{EMAIL_URL}}` / `{{EMAIL_DISPLAY}}` | email (template supplies the `mailto:` prefix) |
| `{{LINKEDIN_URL}}` / `{{LINKEDIN_DISPLAY}}` | LinkedIn link (display strips the scheme) |
| `{{GITHUB_URL}}` / `{{GITHUB_DISPLAY}}` | GitHub link |
| `{{EDUCATION}}` `{{EXPERIENCE}}` `{{PROJECTS}}` `{{SKILLS}}` | rendered section bodies |

## Macro conventions the renderer emits (must exist in the template)

```
Experience  \resumeSubheading{organization}{dates}{title}{location}
Education    \resumeSubheading{institution}{location}{degree}{dates}
Projects     \resumeProjectHeading{\textbf{name} \emph{$|$ stack}}{dates}
Bullets      \resumeItemListStart \resumeItem{...} \resumeItemListEnd
Skills       \textbf{Category}{: comma, separated, items} \\
```

Note the **argument order differs** between Experience and Education — that mirrors
the original sb2nov template and is intentional.

## Escaping

All text pulled from cv.md / tailored content is ATS-normalized (em-dash → `-`,
smart quotes → straight, etc.) and LaTeX-escaped (`& % $ # _ { } ~ ^`) by the
renderer. Do **not** pre-escape content in cv.md; write it naturally.

## Keep it ATS-parseable

Keep `\pdfgentounicode=1` and `\input{glyphtounicode}`. Single column, no text in
images, standard section titles. These make the emitted PDF machine-readable.
