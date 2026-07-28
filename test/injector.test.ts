import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isNativeDocument, injectIntoDocument } from "../src/core/documentInjector.js";
import { validateTex } from "../src/core/latexValidate.js";
import { config } from "../src/config.js";

const SAMPLE = String.raw`\documentclass{article}
\newcommand{\roleheading}[4]{#1 #2 #3 #4}
\newcommand{\projheading}[2]{#1 #2}
\newcommand{\bul}[1]{\item #1}
\newcommand{\bullist}{\begin{itemize}}
\newcommand{\stopbulls}{\end{itemize}}
\begin{document}
\begin{center}{\LARGE Jane Doe}\\ jane@x.com\end{center}
\section{Summary}
\small{OLD SUMMARY}
\section{Experience}
\roleheading{Old Title}{2020}{Old Co}{Nowhere}
\bullist \bul{old bullet} \stopbulls
\section{Projects}
\projheading{Old Proj}{2019}
\bullist \bul{old proj bullet} \stopbulls
\section{Education}
\textbf{MIT} B.S. — KEEP THIS VERBATIM
\end{document}`;

const CONTENT = {
  summary: "NEW tailored summary.",
  experience: [
    { sourceId: "EXP1", title: "Founding Engineer", organization: "Acme", location: "SF, CA", dates: "Jan 2024 - Present", bullets: [{ text: "Shipped a thing in Go.", sourceId: "EXP1.1" }] },
  ],
  projects: [
    { sourceId: "PRJ1", name: "Widget", stack: "Rust, WASM", dates: "2023", bullets: [{ text: "Built a widget.", sourceId: "PRJ1.1" }] },
  ],
  education: [],
  skills: [{ category: "Languages", items: ["Go", "Rust"] }],
};

test("isNativeDocument distinguishes finished docs from placeholder templates", () => {
  assert.equal(isNativeDocument(SAMPLE), true);
  assert.equal(isNativeDocument("\\section{Experience}\n{{EXPERIENCE}}"), false);
  assert.equal(isNativeDocument("plain text"), false);
});

test("injectIntoDocument replaces section bodies but preserves head + education", () => {
  const out = injectIntoDocument(SAMPLE, CONTENT as never);

  // Preamble, custom macros, and header preserved verbatim.
  assert.ok(out.includes("\\newcommand{\\roleheading}"));
  assert.ok(out.includes("{\\LARGE Jane Doe}"));
  // New content injected using the document's own macros.
  assert.ok(out.includes("NEW tailored summary."));
  assert.ok(out.includes("\\roleheading{Founding Engineer}{Jan 2024 -- Present}{Acme}{SF, CA}"));
  assert.ok(out.includes("\\bul{Shipped a thing in Go.}"));
  assert.ok(out.includes("\\projheading{\\textbf{Widget} $|$ \\emph{Rust, WASM}}{2023}"));
  // Old content gone.
  assert.ok(!out.includes("OLD SUMMARY"));
  assert.ok(!out.includes("Old Title"));
  // Education left untouched.
  assert.ok(out.includes("\\textbf{MIT} B.S. — KEEP THIS VERBATIM"));
  // Structure intact.
  assert.ok(out.includes("\\end{document}"));
  assert.equal(out.match(/\{\{[A-Z_]+\}\}/g), null);
});

test("project urls render as \\href in both engines, plain when absent", () => {
  const withUrl = {
    ...CONTENT,
    projects: [
      { sourceId: "PRJ1", name: "Widget", url: "https://github.com/me/widget", stack: "Rust", dates: "2023", bullets: [{ text: "Built it.", sourceId: "PRJ1.1" }] },
      { sourceId: "PRJ2", name: "Plain", stack: "Go", dates: "2022", bullets: [{ text: "Built it too.", sourceId: "PRJ2.1" }] },
    ],
  };
  const out = injectIntoDocument(SAMPLE, withUrl as never);
  assert.ok(out.includes("\\href{https://github.com/me/widget}{Widget}"), "linked project is hyperlinked");
  assert.ok(out.includes("\\textbf{Plain}"), "unlinked project stays plain text");
  assert.ok(!out.includes("\\href{}{Plain}"), "no empty href emitted");
});

test("the user's real main.tex is detected as native and injects cleanly", async () => {
  let mainTex: string;
  try {
    mainTex = await readFile(join(config.templatesDir, "main.tex"), "utf-8");
  } catch {
    return; // main.tex is user-provided; skip if absent
  }
  assert.equal(isNativeDocument(mainTex), true);
  const out = injectIntoDocument(mainTex, CONTENT as never);
  assert.ok(out.includes("\\usepackage{charter}"), "preamble preserved");
  assert.ok(out.includes("NEW tailored summary."), "summary injected");
  const v = validateTex(out);
  assert.equal(v.valid, true, v.errors.join("; "));
});
