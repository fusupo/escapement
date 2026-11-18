import type { Database } from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { schemaErrors } from "./schemas.ts";
import { FactoryError, atomicWrite, blocked, jsonDigest } from "./util.ts";
import { tx, getRun, recordEvent } from "./state.ts";
import type { Owner } from "./owner.ts";

/**
 * The plan critique (docs/FACTORY_DESIGN.md §3.5, #99): a fresh-context
 * critic judges the draft plan and validation contract once, before plan
 * approval. Its document is checked against `critique.schema.json` and the
 * rules below, which the schema can't express.
 */

/** Every checklist item a critique judges, each exactly once. Matches the schema's `$defs/item`. */
export const CHECKLIST_ITEMS = [
  "evidence_capability",
  "clause_coverage",
  "manual_procedure_adequacy",
  "manual_could_be_browser_test",
  "new_behavior_fails_without_change",
  "predicted_files",
  "simpler_approach",
  "lore_conflict",
  "manifest_coupling",
  "tier",
  "issue_size",
] as const;
export type ChecklistItem = (typeof CHECKLIST_ITEMS)[number];

export type CritiqueFinding = {
  id: string;
  severity: "blocking" | "major" | "minor";
  checklist: ChecklistItem;
  ref?: string;
  detail: string;
  suggestion?: string;
};

export type Disposition = {
  finding: string;
  accepted: boolean;
  plan_change?: string;
  reason?: string;
  unresolved?: boolean;
  decided_by: "planner" | "operator";
};

export type Critique = {
  version: 1;
  verdict: "approve" | "revise" | "escalate";
  summary: string;
  tier_raise?: { to: "sensitive"; reason: string };
  checklist: { item: ChecklistItem; result: "ok" | "concern"; note: string }[];
  findings: CritiqueFinding[];
  dispositions?: Disposition[];
};

/**
 * Every problem with a critique document: its schema first, then the rules
 * between fields. `final` (the record after the critique round) also needs
 * a disposition for every finding. Empty means valid.
 */
export function critiqueErrors(data: unknown, opts: { final?: boolean } = {}): string[] {
  const shape = schemaErrors("critique", data);
  if (shape.length) return shape;
  const c = data as Critique;
  const problems: string[] = [];

  const seen = new Map<string, number>();
  for (const e of c.checklist) seen.set(e.item, (seen.get(e.item) ?? 0) + 1);
  for (const item of CHECKLIST_ITEMS) {
    const n = seen.get(item) ?? 0;
    if (n === 0) problems.push(`checklist ${item}: not judged`);
    else if (n > 1) problems.push(`checklist ${item}: judged ${n} times; judge it once`);
  }

  const ids = new Map<string, number>();
  for (const f of c.findings) ids.set(f.id, (ids.get(f.id) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) problems.push(`finding ${id}: used ${n} times; finding IDs are unique`);

  for (const e of c.checklist) {
    if (e.result === "concern" && !c.findings.some((f) => f.checklist === e.item)) {
      problems.push(`checklist ${e.item}: a concern needs a finding that names it`);
    }
  }

  if (c.verdict === "approve") {
    for (const f of c.findings.filter((f) => f.severity === "blocking")) {
      problems.push(`finding ${f.id}: approve can't carry a blocking finding; revise or escalate`);
    }
  } else if (c.findings.length === 0) {
    problems.push(`verdict ${c.verdict}: needs at least one finding`);
  }

  const dispositions = c.dispositions ?? [];
  const given = new Map<string, number>();
  for (const d of dispositions) {
    given.set(d.finding, (given.get(d.finding) ?? 0) + 1);
    if (!ids.has(d.finding)) problems.push(`disposition ${d.finding}: no such finding`);
  }
  for (const [id, n] of given) if (n > 1 && ids.has(id)) problems.push(`finding ${id}: ${n} dispositions; give it one`);
  if (opts.final) {
    for (const id of ids.keys()) if (!given.has(id)) problems.push(`finding ${id}: no disposition (accepted with its plan change, or rejected with a reason)`);
  }
  return problems;
}

export type CritiqueCheck = {
  valid: true;
  final: boolean;
  verdict: Critique["verdict"];
  findings: { blocking: number; major: number; minor: number };
  concerns: ChecklistItem[];
  tier_raise: Critique["tier_raise"] | null;
  dispositions: number;
  /** Findings the operator decided because the planner and critic disagreed (or the critic escalated). */
  unresolved: string[];
};

/** Parse a critique document's text, or refuse it (`bad_critique`) with every problem listed. */
export function parseCritique(text: string, opts: { final?: boolean; source?: string } = {}): Critique {
  const what = opts.source ?? "critique";
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new FactoryError("bad_critique", `${what} is not valid JSON: ${(err as Error).message}`);
  }
  const problems = critiqueErrors(data, { final: opts.final });
  if (problems.length) throw new FactoryError("bad_critique", `${what} is not a valid critique:\n  - ${problems.join("\n  - ")}`);
  return data as Critique;
}

/**
 * `factory check-critique <file> [--final]` (#99): check a critique against
 * critique.schema.json and the rules beyond it, with no run and no
 * database, so a host can check the critic's output before plan approval.
 */
export function checkCritique(text: string, opts: { final?: boolean; source?: string } = {}): CritiqueCheck {
  const c = parseCritique(text, opts);
  const count = (s: CritiqueFinding["severity"]) => c.findings.filter((f) => f.severity === s).length;
  return {
    valid: true,
    final: opts.final ?? false,
    verdict: c.verdict,
    findings: { blocking: count("blocking"), major: count("major"), minor: count("minor") },
    concerns: c.checklist.filter((e) => e.result === "concern").map((e) => e.item),
    tier_raise: c.tier_raise ?? null,
    dispositions: c.dispositions?.length ?? 0,
    unresolved: (c.dispositions ?? []).filter((d) => d.unresolved).map((d) => d.finding),
  };
}

export type RecordCritiqueResult = {
  run_id: string;
  path: string;
  digest: string;
  verdict: Critique["verdict"];
  findings: number;
  accepted: number;
  rejected: number;
  unresolved: string[];
  /** The same critique was already recorded; nothing changed. */
  noop: boolean;
};

function critiqueRecorded(db: Database, runId: string, digest: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM factory_events WHERE run_id = ? AND kind = 'state_change' AND json_extract(detail_json, '$.entity') = 'critique' AND json_extract(detail_json, '$.digest') = ?",
      )
      .get(runId, digest) !== undefined
  );
}

/**
 * `factory record-critique <run_id> <file>` (#99, design §3.5, §7.2): attach
 * the final plan critique to the run that plan approval created. The
 * critique ran before the run existed, so the host records it here.
 *
 * - Checked as `--final`: every finding needs its disposition. A bad
 *   document is `bad_critique` and nothing is written.
 * - Writes `{artifact_dir}/critique.json`, one `critique_finding` event per
 *   finding (§7.2: finding, severity, accepted, plan_change, tokens, plus
 *   the checklist item, reason and who decided), and a `state_change`
 *   event with `entity: critique`.
 * - Idempotent by the document's canonical digest: the same critique again
 *   is a no-op (or finishes a recording a crash interrupted); a different
 *   one is `critique_conflict`. A closed run is refused (`run_closed`).
 */
export function recordCritique(
  db: Database,
  runId: string,
  text: string,
  opts: { owner?: Owner; source?: string } = {},
): RecordCritiqueResult {
  const run = getRun(db, runId);
  if (run.state === "closed") throw blocked("run_closed", `run ${runId} is closed`);
  const c = parseCritique(text, { final: true, source: opts.source });
  const digest = jsonDigest(c);
  const path = join(run.artifact_dir, "critique.json");
  const dispositions = new Map((c.dispositions ?? []).map((d) => [d.finding, d]));
  const result = (noop: boolean): RecordCritiqueResult => ({
    run_id: runId,
    path,
    digest,
    verdict: c.verdict,
    findings: c.findings.length,
    accepted: [...dispositions.values()].filter((d) => d.accepted).length,
    rejected: [...dispositions.values()].filter((d) => !d.accepted).length,
    unresolved: [...dispositions.values()].filter((d) => d.unresolved).map((d) => d.finding),
    noop,
  });

  if (existsSync(path)) {
    let stored: string;
    try {
      stored = jsonDigest(JSON.parse(readFileSync(path, "utf-8")));
    } catch {
      stored = "unreadable";
    }
    if (stored !== digest) {
      throw blocked("critique_conflict", `run ${runId} already has a different critique (${stored}); a recorded critique can't change`);
    }
    if (critiqueRecorded(db, runId, digest)) return result(true);
  } else {
    atomicWrite(path, JSON.stringify(c, null, 2) + "\n");
  }
  return tx(db, () => {
    if (critiqueRecorded(db, runId, digest)) return result(true);
    for (const f of c.findings) {
      const d = dispositions.get(f.id)!;
      recordEvent(db, runId, "critique_finding", {
        finding: f.id,
        severity: f.severity,
        checklist: f.checklist,
        ...(f.ref ? { ref: f.ref } : {}),
        accepted: d.accepted,
        plan_change: d.plan_change ?? null,
        reason: d.reason ?? null,
        unresolved: d.unresolved ?? false,
        decided_by: d.decided_by,
        tokens: null,
      });
    }
    recordEvent(db, runId, "state_change", {
      entity: "critique",
      to: "recorded",
      digest,
      verdict: c.verdict,
      findings: c.findings.length,
      tier_raise: c.tier_raise ?? null,
      owner: opts.owner ?? null,
    });
    return result(false);
  });
}
