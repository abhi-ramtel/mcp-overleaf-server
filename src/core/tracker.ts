/**
 * Application tracker — a CSV "sheet" (opens directly in Excel / Google Sheets,
 * and is git-diffable). Each application is one row: date, company, position,
 * job link, ATS score, the generated resume file, its git link, a JD summary,
 * and a status. Re-recording the same company+position upserts rather than
 * duplicating, so regenerating a resume keeps one clean row.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export interface TrackerRow {
  dateApplied?: string; // YYYY-MM-DD; defaults to today
  company: string;
  position: string;
  jobLink?: string;
  atsScore?: number | string; // percent
  resumeFile?: string;
  gitLink?: string;
  jdSummary?: string;
  status?: string; // e.g. generated | applied | interview | offer | rejected
  notes?: string;
}

const HEADER = [
  "Date Applied",
  "Company",
  "Position",
  "Job Link",
  "ATS %",
  "Resume File",
  "Git Link",
  "JD Summary",
  "Status",
  "Notes",
] as const;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Minimal RFC-4180 CSV parser (handles quotes, escaped quotes, newlines in fields). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      // ignore; handled by the following \n
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function rowToFields(r: TrackerRow): string[] {
  const ats = r.atsScore === undefined || r.atsScore === "" ? "" : String(r.atsScore);
  return [
    r.dateApplied?.trim() || today(),
    r.company ?? "",
    r.position ?? "",
    r.jobLink ?? "",
    ats,
    r.resumeFile ?? "",
    r.gitLink ?? "",
    r.jdSummary ?? "",
    r.status ?? "generated",
    r.notes ?? "",
  ];
}

function fieldsToRow(f: string[]): TrackerRow {
  return {
    dateApplied: f[0] ?? "",
    company: f[1] ?? "",
    position: f[2] ?? "",
    jobLink: f[3] ?? "",
    atsScore: f[4] ?? "",
    resumeFile: f[5] ?? "",
    gitLink: f[6] ?? "",
    jdSummary: f[7] ?? "",
    status: f[8] ?? "",
    notes: f[9] ?? "",
  };
}

/** Read all rows from the tracker (empty array if the file doesn't exist). */
export async function listApplications(trackerPath: string): Promise<TrackerRow[]> {
  if (!existsSync(trackerPath)) return [];
  const rows = parseCsv(await readFile(trackerPath, "utf-8"));
  return rows.slice(1).filter((r) => r.some((c) => c.trim() !== "")).map(fieldsToRow);
}

function key(company: string, position: string): string {
  return `${company.trim().toLowerCase()}|${position.trim().toLowerCase()}`;
}

/** Delete a row by company (+ optional position). Returns how many were removed. */
export async function removeApplication(
  trackerPath: string,
  company: string,
  position?: string,
): Promise<number> {
  const existing = await listApplications(trackerPath);
  const co = company.trim().toLowerCase();
  const pos = position?.trim().toLowerCase();
  const keep = existing.filter((r) => {
    const sameCompany = (r.company ?? "").trim().toLowerCase() === co;
    const samePosition = pos === undefined || (r.position ?? "").trim().toLowerCase() === pos;
    return !(sameCompany && samePosition);
  });
  if (keep.length === existing.length) return 0;
  const lines = [HEADER.join(","), ...keep.map((r) => rowToFields(r).map(csvEscape).join(","))];
  await writeFile(trackerPath, lines.join("\n") + "\n", "utf-8");
  return existing.length - keep.length;
}

/**
 * Upsert an application row (keyed on company+position) and rewrite the sheet.
 * Returns whether it created a new row or updated an existing one.
 */
export async function recordApplication(
  trackerPath: string,
  row: TrackerRow,
): Promise<{ created: boolean; total: number }> {
  await mkdir(dirname(trackerPath), { recursive: true });
  const existing = await listApplications(trackerPath);
  const k = key(row.company, row.position);
  const idx = existing.findIndex((r) => key(r.company, r.position) === k);

  const normalized: TrackerRow = { ...row, dateApplied: row.dateApplied?.trim() || today() };
  let created: boolean;
  if (idx >= 0) {
    // Preserve the original applied date and any status/notes not being overwritten.
    const prev = existing[idx]!;
    existing[idx] = {
      ...prev,
      ...normalized,
      dateApplied: prev.dateApplied || normalized.dateApplied,
      status: normalized.status ?? prev.status,
      notes: normalized.notes ?? prev.notes,
    };
    created = false;
  } else {
    existing.push(normalized);
    created = true;
  }

  const lines = [HEADER.join(","), ...existing.map((r) => rowToFields(r).map(csvEscape).join(","))];
  await writeFile(trackerPath, lines.join("\n") + "\n", "utf-8");
  return { created, total: existing.length };
}
