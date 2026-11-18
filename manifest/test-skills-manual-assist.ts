// Agent-assisted manual checks (#103): the validate-work text that carries
// out a manual check and leaves the outcome to the operator, and the
// archive-work copy list that keeps the attachments.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./factory/testkit.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf-8");

/** The text of a `## ` or `### ` section, up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const level = heading.match(/^#+/)?.[0] ?? "##";
  const next = new RegExp(`\\n#{2,${level.length}} `, "g");
  next.lastIndex = start + heading.length;
  const m = next.exec(text);
  return text.slice(start, m ? m.index : undefined);
}

/** The numbered step `n.` of a section, up to the next numbered step. */
function step(text: string, n: number): string {
  const start = text.search(new RegExp(`\\n${n}\\. `));
  if (start < 0) return "";
  const rest = text.slice(start + 1);
  const next = rest.search(new RegExp(`\\n${n + 1}\\. `));
  return next < 0 ? rest : rest.slice(0, next);
}

function validateWork() {
  console.log("validate-work: carrying out a manual check\n");
  const skill = read("skills/validate-work/SKILL.md");
  const front = skill.slice(0, skill.indexOf("\n---", 4));
  const carry = section(skill, "## Carrying Out a Manual Check");
  const phase1 = section(skill, "### Phase 1: Find the Run");
  const at = (h: string) => skill.indexOf(h);

  assert(
    carry !== "" &&
      at("## Carrying Out a Manual Check") < at("## Recording a Manual Check") &&
      /run the manual check AC-7\.e6/i.test(front) &&
      front.includes("mcp__plugin_escapement_playwright__*") &&
      phase1.includes("go to **Carrying Out a Manual Check**") &&
      /matched or not/.test(phase1) &&
      step(carry, 1).includes("`{artifact_dir}/contract.json`") &&
      step(carry, 1).includes("`instructions`") &&
      step(carry, 1).includes("type: manual") &&
      step(carry, 5).includes('At each "Check:", report what you saw in a sentence of your own') &&
      step(carry, 5).includes("in the browser") &&
      step(carry, 5).includes("or the shell"),
    "validate-work carries out a manual check on request from the contract's instructions, reporting each Check with what it saw",
  );

  const s3 = step(carry, 3);
  const s5 = step(carry, 5);
  const s7 = step(carry, 7);
  const s8 = step(carry, 8);
  assert(
    s3.includes("`{artifact_dir}/manual/{evidence_id}/`") &&
      /Never write in the worktree/.test(s3) &&
      s5.includes("take a screenshot") &&
      s5.includes("copy it into `{artifact_dir}/manual/{evidence_id}/`") &&
      s7.includes("`{artifact_dir}/manual/{evidence_id}/observations.md`") &&
      step(carry, 4).includes("in the background") &&
      /Stop every background process/.test(s8) &&
      s8.includes("even when a step failed") &&
      s8.includes("ss -ltn") &&
      /handed back to the operator\. Never guess it\./.test(step(carry, 2)) &&
      /reported as not done/.test(s5),
    "validate-work saves screenshots and observations under {artifact_dir}/manual/{evidence_id}, stops background processes, and hands back steps it cannot do",
  );

  const s6 = step(carry, 6);
  assert(
    s6.includes("`is not installed`") &&
      s6.includes("stop the check") &&
      s6.includes("Record nothing") &&
      s6.includes("npx -y @playwright/mcp@0.0.84 install-browser chrome-for-testing") &&
      /unpinned/.test(s6),
    "validate-work stops the check when the browser is not installed, names the pinned install command, and records nothing",
  );

  const s9 = step(carry, 9);
  const s10 = step(carry, 10);
  assert(
    s9.includes("Show the observations") &&
      s9.includes("AskUserQuestion") &&
      s9.includes("The outcome is always the operator's: record nothing until they answer, and nothing on your own judgment") &&
      s9.includes('"Don\'t record"') &&
      /you never decide it/.test(carry) &&
      s10.includes("--assisted --attachment") &&
      /The recorder is the operator .*never the agent/.test(s10) &&
      section(skill, "## Recording a Manual Check").includes("Never record one on your own judgment"),
    "validate-work asks the operator for the outcome showing the observations, and never records one on its own judgment",
  );
}

function archiveWork() {
  console.log("\narchive-work: the manual-check attachments\n");
  const skill = read("skills/archive-work/SKILL.md");
  const phase = section(skill, "### Phase 6.5: Archive the Factory Run");
  const find = phase.match(/find \. -type f \\\((.*?)\\\)\)/)?.[1] ?? "";
  assert(
    find.includes("-path './manual/*'") &&
      find.includes("-name contract.json") &&
      find.includes("-path ./pr/body.md") &&
      !find.includes("logs"),
    "archive-work's Phase 6.5 copy list includes the manual attachments",
  );
}

validateWork();
archiveWork();
console.log("\nAll manual-assist skill tests passed.");
