// The plan critique in setup-work (docs/FACTORY_DESIGN.md §3.5, #99): the
// skill text that runs it, and the docs that record it as built.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./factory/testkit.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf-8");

/** The text of a `### ` section, up to the next `### ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const next = text.indexOf("\n### ", start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
}

function setupWork() {
  console.log("setup-work: the plan critique\n");
  const skill = read("skills/setup-work/SKILL.md");
  const at = (h: string) => skill.indexOf(h);
  const critique = section(skill, "### Phase 3.55: Plan Critique [factory]");
  const approval = section(skill, "### Phase 3.6: Plan Approval");

  assert(
    critique !== "" &&
      at("### Phase 3.2: Check the Contract [factory]") < at("### Phase 3.55") &&
      at("### Phase 3.5: Interactive Q&A") < at("### Phase 3.55") &&
      at("### Phase 3.55") < at("### Phase 3.6: Plan Approval") &&
      critique.includes("subagent_type: escapement:plan-critic") &&
      critique.includes("check-critique") &&
      /on the factory path/i.test(critique),
    "setup-work runs the plan critique on the factory path after the contract check and before plan approval",
  );
  assert(
    /resume the scratchpad-planner agent \*\*once\*\*/.test(critique) &&
      critique.includes("The revised plan isn't critiqued again") &&
      approval.includes("The revision isn't critiqued again (one round)"),
    "the critique is one round: revise returns to the planner once and the revised plan isn't critiqued again",
  );
  assert(
    critique.includes("a new agent with fresh context, given only the brief") &&
      ['"issue"', '"scratchpad"', '"contract"', '"repo"'].every((k) => critique.includes(k)) &&
      critique.includes("Never resume the scratchpad-planner for this, and never pass the planner's transcript"),
    "the critic is a fresh agent briefed with the issue, scratchpad and contract, never the planner's transcript",
  );
  const summary = approval.slice(0, approval.indexOf("2. **Request Approval:**"));
  assert(
    summary.includes("Unresolved critique findings") &&
      summary.includes("Critic:") &&
      summary.includes("Planner:") &&
      summary.includes("Never ask the approval question before the operator has seen them") &&
      /`blocking` or `major` finding the planner rejected is \*\*unresolved\*\*/.test(critique),
    "unresolved critique findings are shown with both positions in the plan summary before the approval question",
  );

  const template = skill.slice(at("## Plan Critique"), at("## Branch Strategy"));
  const authorize = section(skill, "### Phase 4.5: Authorize the Run [factory]");
  const record = authorize.indexOf("record-critique '{run_id}'");
  assert(
    template.includes("| Finding | Severity | Checklist | Ref | Critic | Disposition |") &&
      /Record it in the scratchpad\*\*, in `## Plan Critique`/.test(critique) &&
      approval.includes("Each unresolved finding gets a disposition `decided_by: operator`") &&
      record > authorize.indexOf("3. **Start the run:**") &&
      record < authorize.indexOf("6. **Approve it:**"),
    "setup-work records each finding's disposition in the scratchpad and runs record-critique after start",
  );
  assert(critique.includes("set the contract's `risk_tier_proposed` to `sensitive`"), "a critic's tier raise is applied, never asked");
}

function docs() {
  console.log("\nThe docs record it as built\n");
  const design = read("docs/FACTORY_DESIGN.md");
  const s35 = section(design, "### 3.5 Critique loop");
  assert(
    s35 !== "" && !design.includes("### 3.5 Critique loop (next)") && !design.includes("6. critique loop            [next]") &&
      s35.includes("*As built (#99):*") &&
      ["plan-critic.md", "critique.schema.json", "check-critique", "record-critique", "`critique_finding`", "## Plan Critique", "Critic:", "Planner:"].every((w) => s35.includes(w)),
    "FACTORY_DESIGN.md §3.5 is marked as built by #99 and no longer next",
  );
  const step11 = design.split("\n").find((l) => /^11\. /.test(l)) ?? "";
  const next = section(design, "### 2.2 Next (in order)");
  assert(
    /^11\. \*\*#99 Plan critique\*\*, one round\. \*\*Done\.\*\*/.test(step11) && /2\. \*\*Plan critique\*\*[^\n]*\*\*Done\*\* \(#99/.test(next),
    "FACTORY_DESIGN.md §10 step 11 is Done and names #99, and §2.2 lists plan critique as done",
  );
  assert(
    /rejected manual procedure escalates at once \(#99\)/.test(section(design, "### 6.2 Fix loop")),
    "FACTORY_DESIGN.md §6.2 records the rejected-manual-procedure backstop",
  );
  const cli = read("docs/FACTORY_CLI.md");
  const schemas = read("schemas/factory/README.md");
  assert(
    cli.includes("### check-critique") && cli.includes("### record-critique") &&
      cli.includes("| `check-critique <file> [--final]` |") && cli.includes("| `record-critique <run_id> <file>` |") &&
      cli.includes("- **check-critique:**") && cli.includes("- **record-critique:**") &&
      schemas.includes("| `critique.schema.json` |"),
    "FACTORY_CLI.md documents check-critique and record-critique, and the schemas README lists critique.schema.json",
  );
}

try {
  setupWork();
  docs();
  console.log("\nAll setup-work critique checks passed.");
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
