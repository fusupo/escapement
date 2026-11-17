// The plan critique (docs/FACTORY_DESIGN.md §3.5, #99): the critic's
// document, the rules beyond its schema, and its record on a run.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { CHECKLIST_ITEMS, critiqueErrors, recordCritique, type Critique } from "./factory/critique.ts";
import { schemaPath } from "./factory/schemas.ts";
import { transitionRun } from "./factory/state.ts";
import { assert, throws, cleanup } from "./factory/testkit.ts";
import { project } from "./factory/fixtures.ts";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** A revise verdict with one blocking finding the planner accepted. */
function critique(): Critique {
  return {
    version: 1,
    verdict: "revise",
    summary: "AC-2 names two places; its evidence covers one.",
    checklist: CHECKLIST_ITEMS.map((item) => ({ item, result: item === "clause_coverage" ? "concern" : "ok", note: "checked" })),
    findings: [{ id: "F-1", severity: "blocking", checklist: "clause_coverage", ref: "AC-2", detail: "the CLI clause has no evidence" }],
    dispositions: [{ finding: "F-1", accepted: true, plan_change: "added AC-2.e2, a command item for the CLI", decided_by: "planner" }],
  };
}

function rules() {
  console.log("Critique rules\n");
  const schema = JSON.parse(readFileSync(schemaPath("critique"), "utf-8")) as { $defs: { item: { enum: string[] } } };
  assert(schema.$defs.item.enum.join() === CHECKLIST_ITEMS.join(), "the runner's checklist is the schema's");
  assert(critiqueErrors(critique()).length === 0 && critiqueErrors(critique(), { final: true }).length === 0, "a valid critique has no problems");

  const missing = clone(critique());
  missing.checklist = missing.checklist.filter((e) => e.item !== "issue_size");
  const twice = clone(critique());
  twice.checklist.push({ item: "tier", result: "ok", note: "again" });
  const dupIds = clone(critique());
  dupIds.findings.push({ ...dupIds.findings[0], severity: "minor" });
  const approving = { ...clone(critique()), verdict: "approve" as const };
  const empty = { ...clone(critique()), findings: [], dispositions: [] };
  empty.checklist = empty.checklist.map((e) => ({ ...e, result: "ok" as const }));
  const problems = [
    critiqueErrors(missing).join(),
    critiqueErrors(twice).join(),
    critiqueErrors(dupIds).join(),
    critiqueErrors(approving).join(),
    critiqueErrors(empty).join(),
    critiqueErrors({ ...empty, verdict: "escalate" }).join(),
  ];
  assert(
    problems[0] === "checklist issue_size: not judged" &&
      problems[1] === "checklist tier: judged 2 times; judge it once" &&
      problems[2] === "finding F-1: used 2 times; finding IDs are unique" &&
      problems[3] === "finding F-1: approve can't carry a blocking finding; revise or escalate" &&
      problems[4] === "verdict revise: needs at least one finding" &&
      problems[5] === "verdict escalate: needs at least one finding",
    "critique rules beyond the schema: every checklist item once, unique finding IDs, approve carries no blocking finding, revise needs a finding",
  );
  assert(critiqueErrors({ ...empty, verdict: "approve" }).length === 0, "approve with no findings is valid");

  const unbacked = clone(critique());
  unbacked.checklist = unbacked.checklist.map((e) => (e.item === "tier" ? { ...e, result: "concern" } : e));
  assert(critiqueErrors(unbacked).join() === "checklist tier: a concern needs a finding that names it", "a concern needs a finding that names its checklist item");

  const stray = clone(critique());
  stray.dispositions!.push({ finding: "F-9", accepted: false, reason: "n/a", decided_by: "planner" });
  assert(critiqueErrors(stray).join() === "disposition F-9: no such finding", "a disposition names a finding the critique has");
  const doubled = clone(critique());
  doubled.dispositions!.push({ finding: "F-1", accepted: false, reason: "changed our mind", decided_by: "operator" });
  assert(critiqueErrors(doubled).join() === "finding F-1: 2 dispositions; give it one", "each finding has at most one disposition");

  const open = { ...clone(critique()), dispositions: undefined };
  assert(critiqueErrors(open).length === 0, "the critic's own document has no dispositions yet");
  assert(
    critiqueErrors(open, { final: true }).join() === "finding F-1: no disposition (accepted with its plan change, or rejected with a reason)",
    "the final record needs a disposition for every finding",
  );
  assert(critiqueErrors({ ...critique(), verdict: "maybe" })[0].startsWith("/verdict"), "schema problems come first, and alone");
}

type Event = { kind: string; detail: Record<string, unknown> };
function events(db: Database, runId: string): Event[] {
  return (db.prepare("SELECT kind, detail_json FROM factory_events WHERE run_id = ? AND kind IN ('critique_finding', 'state_change') ORDER BY id").all(runId) as { kind: string; detail_json: string }[])
    .map((e) => ({ kind: e.kind, detail: JSON.parse(e.detail_json) as Record<string, unknown> }))
    .filter((e) => e.kind === "critique_finding" || e.detail.entity === "critique");
}

/** The final record: F-1 accepted by the planner, F-2 rejected by the operator after the two disagreed. */
function finalCritique(): Critique {
  const c = critique();
  c.findings.push({ id: "F-2", severity: "minor", checklist: "predicted_files", detail: "README.md isn't predicted" });
  c.dispositions!.push({ finding: "F-2", accepted: false, reason: "the README doesn't change", unresolved: true, decided_by: "operator" });
  return c;
}

async function recording() {
  console.log("\nrecord-critique\n");
  {
    const { db, run } = await project({});
    const r = recordCritique(db, run.run_id, JSON.stringify(finalCritique(), null, 2));
    const path = join(run.artifact_dir, "critique.json");
    const ev = events(db, run.run_id);
    const findings = ev.filter((e) => e.kind === "critique_finding").map((e) => e.detail);
    assert(
      !r.noop && r.path === path && existsSync(path) && JSON.parse(readFileSync(path, "utf-8")).dispositions.length === 2 &&
        findings.length === 2 && ev.filter((e) => e.kind === "state_change").length === 1,
      "record-critique stores critique.json in the run's artifact dir and one critique_finding event per finding",
    );
    const [f1, f2] = findings;
    assert(
      f1.finding === "F-1" && f1.severity === "blocking" && f1.accepted === true && f1.plan_change === "added AC-2.e2, a command item for the CLI" && f1.tokens === null &&
        f2.finding === "F-2" && f2.accepted === false && f2.reason === "the README doesn't change" && f2.unresolved === true && f2.decided_by === "operator",
      "each event carries the finding, its severity and its disposition (§7.2)",
    );
    assert(r.accepted === 1 && r.rejected === 1 && r.unresolved.join() === "F-2", "the result counts accepted, rejected and operator-decided findings");

    const again = recordCritique(db, run.run_id, JSON.stringify(finalCritique()));
    const other = finalCritique();
    other.dispositions![1] = { finding: "F-2", accepted: true, plan_change: "predicted README.md", decided_by: "operator" };
    let conflict = "";
    try {
      recordCritique(db, run.run_id, JSON.stringify(other));
    } catch (err) {
      conflict = (err as { code?: string }).code ?? "";
    }
    assert(
      again.noop && events(db, run.run_id).length === 3 && conflict === "critique_conflict",
      "recording the same critique again is a no-op and a different one is critique_conflict",
    );
  }
  {
    const { db, run } = await project({});
    const accepted = finalCritique();
    delete accepted.dispositions![0].plan_change;
    throws(() => recordCritique(db, run.run_id, JSON.stringify(accepted)), /bad_critique.*missing "plan_change"/s, "an accepted finding must name the plan change it caused");
    const rejected = finalCritique();
    delete rejected.dispositions![1].reason;
    throws(() => recordCritique(db, run.run_id, JSON.stringify(rejected)), /bad_critique.*missing "reason"/s, "a rejected finding must give the reason");
    const undecided = finalCritique();
    undecided.dispositions!.pop();
    throws(() => recordCritique(db, run.run_id, JSON.stringify(undecided)), /bad_critique.*F-2: no disposition/s, "a finding without a disposition is refused when the critique is recorded");
    assert(!existsSync(join(run.artifact_dir, "critique.json")) && events(db, run.run_id).length === 0, "a refused critique writes nothing");
  }
  {
    // A crash after critique.json was written, before its events.
    const { db, run } = await project({});
    writeFileSync(join(run.artifact_dir, "critique.json"), JSON.stringify(finalCritique()));
    const r = recordCritique(db, run.run_id, JSON.stringify(finalCritique()));
    assert(!r.noop && events(db, run.run_id).length === 3, "the same critique finishes a recording a crash interrupted");
  }
  {
    const { db, run } = await project({});
    transitionRun(db, run.run_id, "escalated", { reason: "test" });
    transitionRun(db, run.run_id, "closed", { reason: "test", action: "abandoned" });
    throws(() => recordCritique(db, run.run_id, JSON.stringify(finalCritique())), /run_closed/, "a closed run takes no critique");
  }
}

try {
  rules();
  await recording();
  console.log("\nAll factory critique tests passed.");
} finally {
  cleanup();
}
