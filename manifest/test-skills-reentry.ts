// Re-entry after the PR is open (#97): the skill text that takes a run with
// a PR back to implementation (do-work), refreshes its PR with a rewritten
// narrative (create-pr), and points a failed manual check at it
// (validate-work).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./factory/testkit.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf-8");

/** The paragraph or block that starts with `start`, up to the next bold-led paragraph or heading. */
function part(text: string, start: string): string {
  const i = text.indexOf(start);
  if (i < 0) return "";
  const rest = text.slice(i + start.length);
  const m = rest.search(/\n\*\*[A-Z][^*\n]*\.\*\*|\n#{2,3} /);
  return start + (m < 0 ? rest : rest.slice(0, m));
}

function doWork() {
  console.log("do-work\n");
  const skill = read("skills/do-work/SKILL.md");
  const escalated = part(skill, "**Escalated after a failed attempt.**");
  const back = part(skill, "**Back to an open PR.**");
  assert(
    escalated.includes("A run with a PR can now continue") && escalated.includes("`.result.run.pr_number` set") &&
      escalated.includes("failed manual check") && !escalated.includes("can't go back to implementation yet") &&
      back.includes("matched `pr_open` run") && back.includes("--trigger review_finding") && back.includes("`operator_request`") &&
      back.includes("continue '{run_id}'") && !skill.includes("has_pr"),
    "do-work offers continue for an escalated run with a PR and for a matched pr_open run, passes the trigger, and no longer refuses with has_pr",
  );
  const unmatched = skill.slice(skill.indexOf("- **`--check` fails, or `.result.matched` is false:**"), skill.indexOf("- **Matched:** authorized."));
  assert(
    unmatched.includes('`["run_deadline"]`') && unmatched.includes("`pr_open`") && unmatched.includes("**Back to an open PR**") &&
      unmatched.indexOf("**Back to an open PR**") < unmatched.indexOf("Any other") && back.includes("only reason is `run_deadline`"),
    "do-work's unmatched branch offers continue for a pr_open run whose only reason is run_deadline",
  );
  const stepA = part(skill, "### A. Implement");
  assert(
    skill.includes("**Back on an open PR** (the `fix` has a `trigger`, #97)") && skill.includes("`fix.reason` is the work") &&
      stepA.length > 0 && skill.includes("Re-entry on PR #{pr_number} ({fix.trigger})"),
    "do-work treats a fix with a trigger as the re-entry's work: the reason when there are no findings",
  );
  assert(back.includes("AskUserQuestion") && back.includes("Leave the PR as it is"), "do-work asks the operator before taking a pr_open run back");
}

function createPr() {
  console.log("\ncreate-pr\n");
  const skill = read("skills/create-pr/SKILL.md");
  const refresh = part(skill, "  - **Refresh after a re-entry** (#97)");
  assert(
    refresh.includes("`.result.reentry`") && refresh.includes("rewrite it") && refresh.includes("`--body-file`") &&
      refresh.includes("keeps the old narrative") && refresh.includes("awaiting a human again"),
    "create-pr rewrites the narrative and passes --body-file when refreshing after a re-entry",
  );
}

function validateWork() {
  console.log("\nvalidate-work\n");
  const skill = read("skills/validate-work/SKILL.md");
  const resolved = skill.slice(skill.indexOf("- **`.result.resolved` is `pass` or `fail`:**"), skill.indexOf("- **`.result.refresh_pr` is true:**"));
  assert(
    resolved.includes("A failed manual check can be re-entered through do-work (#97)") && resolved.includes("same PR") && resolved.includes("new head"),
    "validate-work says a failed manual check can be re-entered through do-work",
  );
}

doWork();
createPr();
validateWork();
console.log("\nAll re-entry skill tests passed.");
