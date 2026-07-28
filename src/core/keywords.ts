/**
 * Deterministic (no-LLM) ATS keyword tooling: extract candidate keywords from a
 * job description, score how well a rendered resume covers them, and split the
 * gap into "addable" (already in your master CV — safe to surface) vs "absent"
 * (not in your CV — cannot be added without fabricating).
 *
 * This is intentionally a heuristic aid for the host model, not a scorer of
 * record. It never invents; it only measures overlap.
 */
import { normalizeText } from "./atsNormalize.js";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "you", "our", "are", "will", "your", "who", "all", "any", "can",
  "has", "have", "this", "that", "they", "them", "their", "from", "into", "out", "not", "but",
  "was", "were", "been", "being", "his", "her", "its", "she", "him", "one", "two", "how", "why",
  "what", "when", "where", "which", "while", "work", "working", "role", "team", "teams", "years",
  "year", "experience", "ability", "able", "strong", "including", "etc", "plus", "using", "use",
  "used", "help", "helping", "build", "building", "across", "within", "over", "more", "most",
  "other", "such", "may", "must", "should", "would", "could", "about", "also", "well", "new",
  "job", "candidate", "candidates", "position", "company", "companies", "looking", "join",
  "responsibilities", "requirements", "qualifications", "preferred", "required", "skills", "skill",
  "knowledge", "understanding", "environment", "great", "good", "excellent", "best", "like",
  "week", "day", "days", "per", "get", "got", "make", "made", "via", "each", "both", "many",
  // Generic job-post prose that isn't an ATS keyword (verbs/adjectives/fillers).
  "turn", "own", "part", "right", "next", "define", "important", "real", "actually", "someone",
  "people", "person", "want", "wants", "comfort", "curiosity", "agency", "ego", "bonus", "ready",
  "close", "taste", "instinct", "instincts", "intuition", "before", "messy", "scattered", "crisp",
  "high", "low", "deep", "deeply", "first", "every", "lot", "come", "arrive", "sit", "offer",
]);

// Short tokens that are meaningful tech terms and must survive the length filter.
const SHORT_WHITELIST = new Set(["c", "r", "go", "ai", "ml", "js", "ts", "ci", "cd", "qa", "ux", "ui", "os", "db"]);

// Multi-word phrases worth catching as single keywords when present verbatim.
const TECH_PHRASES = [
  "machine learning", "deep learning", "distributed systems", "data structures", "ci/cd",
  "rest api", "rest apis", "api design", "event driven", "event-driven", "micro services",
  "microservices", "cloud infrastructure", "back end", "back-end", "front end", "front-end",
  "full stack", "full-stack", "unit testing", "version control", "object oriented",
  "object-oriented", "natural language processing", "computer vision", "large language models",
  "system design", "continuous integration", "continuous delivery", "message queue",
  "load balancing", "fault tolerant", "high availability", "low latency", "test driven",
  "test-driven", "infrastructure as code", "data pipelines", "data pipeline", "real time",
  "real-time", "reinforcement learning", "operating systems", "web services",
];

function tokenize(text: string): string[] {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9+#./\- ]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[.\-/]+|[.\-/]+$/g, ""))
    .filter(Boolean);
}

function keepToken(t: string): boolean {
  if (STOPWORDS.has(t)) return false;
  if (/^[0-9]+$/.test(t)) return false;
  if (t.length >= 3) return true;
  return SHORT_WHITELIST.has(t);
}

export interface ExtractOptions {
  max?: number;
}

/** Extract ranked candidate keywords (single tokens + known phrases) from a JD. */
export function extractKeywords(jd: string, opts: ExtractOptions = {}): string[] {
  const max = opts.max ?? 40;
  const lower = normalizeText(jd).toLowerCase();

  const freq = new Map<string, number>();
  for (const t of tokenize(jd)) {
    if (keepToken(t)) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  // Phrases: count occurrences; give them a small boost so they rank as units.
  for (const phrase of TECH_PHRASES) {
    let idx = 0;
    let count = 0;
    while ((idx = lower.indexOf(phrase, idx)) !== -1) {
      count++;
      idx += phrase.length;
    }
    if (count > 0) freq.set(phrase, (freq.get(phrase) ?? 0) + count + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([kw]) => kw);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if a keyword appears in target text (word-boundary for plain words). */
function present(keyword: string, targetLower: string): boolean {
  if (/[^a-z0-9]/.test(keyword)) return targetLower.includes(keyword);
  return new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i").test(targetLower);
}

export interface CoverageResult {
  score: number; // 0..1
  percent: number; // 0..100, rounded
  matched: string[];
  missing: string[];
}

/** Fraction of JD keywords that appear in the target (resume) text. */
export function scoreCoverage(keywords: string[], targetText: string): CoverageResult {
  const target = normalizeText(targetText).toLowerCase();
  const matched: string[] = [];
  const missing: string[] = [];
  for (const kw of keywords) {
    (present(kw, target) ? matched : missing).push(kw);
  }
  const score = keywords.length ? matched.length / keywords.length : 0;
  return { score, percent: Math.round(score * 100), matched, missing };
}

export interface GapResult {
  /** In your master CV but missing from the resume — safe to surface truthfully. */
  addable: string[];
  /** Not in your master CV at all — cannot be added without fabricating. */
  absent: string[];
}

/** Split JD keywords missing from the resume into addable vs. absent. */
export function keywordGap(keywords: string[], resumeText: string, masterCvText: string): GapResult {
  const resume = normalizeText(resumeText).toLowerCase();
  const master = normalizeText(masterCvText).toLowerCase();
  const addable: string[] = [];
  const absent: string[] = [];
  for (const kw of keywords) {
    if (present(kw, resume)) continue;
    (present(kw, master) ? addable : absent).push(kw);
  }
  return { addable, absent };
}
