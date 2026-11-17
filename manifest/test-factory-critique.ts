// The plan critique (docs/FACTORY_DESIGN.md §3.5, #99): the critic's
// document, the rules beyond its schema, and its record on a run.
import { readFileSync } from "node:fs";
import { CHECKLIST_ITEMS, critiqueErrors, type Critique } from "./factory/critique.ts";
import { schemaPath } from "./factory/schemas.ts";
import { assert, cleanup } from "./factory/testkit.ts";

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

try {
  rules();
  console.log("\nAll factory critique tests passed.");
} finally {
  cleanup();
}
