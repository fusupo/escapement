import type { Database } from "better-sqlite3";
import { schemaErrors } from "./factory/schemas.ts";

/**
 * Mirror a readiness check (docs/FACTORY_DESIGN.md §3.1, readiness.schema.json)
 * into the manifest work item for the same issue, so a work item that needs a
 * human leaves the frontier and the dispatch plan.
 *
 * - `needs_human`: `meta.needs_human = true` and `meta.readiness_questions` =
 *   the questions.
 * - `ready`: `meta.readiness_questions` is removed, and `meta.needs_human`
 *   too unless `meta.ambiguities` (manifest-bootstrap's dependency questions)
 *   still holds entries.
 *
 * Readiness questions get their own key so they never overwrite or clear
 * bootstrap's `ambiguities`.
 */

export type ReadinessDoc = {
  version: 1;
  status: "ready" | "needs_human";
  questions: { about: string; question: string; ref?: string }[];
};

export type MirrorResult =
  | { mirrored: false; reason: "no_work_item"; repo: string; issue: number }
  | { mirrored: true; id: string; status: ReadinessDoc["status"]; needs_human: boolean; questions: number };

export function parseReadiness(text: string, source = "readiness"): ReadinessDoc {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  const errors = schemaErrors("readiness", data);
  if (errors.length > 0) throw new Error(`${source} is not a readiness document:\n  ${errors.join("\n  ")}`);
  return data as ReadinessDoc;
}

export function mirrorReadiness(db: Database, opts: { repo: string; issue: number; readiness: ReadinessDoc }): MirrorResult {
  const { repo, issue, readiness } = opts;
  const rows = db
    .prepare("SELECT id, meta FROM work_items WHERE repo = ? AND issue_number = ? ORDER BY id")
    .all(repo, issue) as { id: string; meta: string }[];
  if (rows.length === 0) return { mirrored: false, reason: "no_work_item", repo, issue };
  if (rows.length > 1) {
    throw new Error(`${rows.length} work items match ${repo}#${issue} (${rows.map((r) => r.id).join(", ")}); expected one`);
  }
  const row = rows[0];
  let meta: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.meta || "{}");
    meta = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    meta = {};
  }

  if (readiness.status === "needs_human") {
    meta.needs_human = true;
    meta.readiness_questions = readiness.questions;
  } else {
    delete meta.readiness_questions;
    const ambiguities = meta.ambiguities;
    if (Array.isArray(ambiguities) && ambiguities.length > 0) meta.needs_human = true;
    else delete meta.needs_human;
  }

  db.prepare("UPDATE work_items SET meta = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(
    JSON.stringify(meta),
    row.id,
  );
  return {
    mirrored: true,
    id: row.id,
    status: readiness.status,
    needs_human: meta.needs_human === true,
    questions: readiness.status === "needs_human" ? readiness.questions.length : 0,
  };
}
