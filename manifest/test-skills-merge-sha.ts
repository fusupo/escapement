import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./factory/testkit.ts";

/**
 * #117: archive-work records the merge SHA and sweeps for reverts after a
 * close, and the docs describe both as built. Skills are read from disk:
 * the Skill tool serves the text a session loaded, not the current file.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf-8");

/** The text from `start` up to (not including) `end`, or "" when `start` is missing. */
function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  if (i < 0) return "";
  const j = text.indexOf(end, i + start.length);
  return j < 0 ? text.slice(i) : text.slice(i, j);
}

function run() {
  console.log("archive-work (#117)\n");
  const skill = read("skills/archive-work/SKILL.md");
  const phase = between(skill, "### Phase 6.5: Archive the Factory Run", "### Phase 7: Report Result");
  const report = between(skill, "### Phase 7: Report Result", "## Archive Options");
  const sweep = between(phase, "3. **Sweep for reverts**", "\n### ");
  const closeAt = phase.indexOf(`--json archive '{run_id}' --path "$DEST" --close`);
  const revertsAt = phase.indexOf('bash "$FACTORY" --json reverts');
  const okBullet = phase.split("\n").find((l) => l.includes("- **`.ok`:** the run is `closed`")) ?? "";

  assert(
    closeAt >= 0 &&
      revertsAt > closeAt &&
      sweep.includes('bash "$FACTORY" --json reverts') &&
      okBullet.includes("`.result.merge_sha`") &&
      report.includes("merge: {merge_sha}") &&
      /Reverts: \{N\} recorded/.test(report),
    "archive-work Phase 6.5 runs factory reverts after the close and reports the merge SHA",
  );
  assert(
    /\*\*Any failure or refusal:\*\* one line in Phase 7, `reverts not checked: \{message\}`/.test(sweep) &&
      /never undoes or blocks closing the run/.test(sweep) &&
      report.includes("reverts not checked: {message}"),
    "archive-work says a failed reverts sweep is reported and never undoes or blocks closing the run",
  );
  assert(
    sweep.length > 0 && !sweep.includes("AskUserQuestion") && !okBullet.includes("AskUserQuestion") && /no question to the operator/.test(sweep),
    "archive-work's new reverts step exists and, with the merge SHA report, contains no AskUserQuestion, so the operator has no new step",
  );

  const readme = read("README.md");
  assert(
    skill.includes("**Version:** 2.7.0") &&
      /^- v2\.7\.0: .*\(#117\)$/m.test(skill) &&
      JSON.parse(read(".claude-plugin/plugin.json")).version === "4.7.0" &&
      readme.includes("**Current:** 4.7.0") &&
      /^- 4\.7\.0 \(\d{4}-\d{2}-\d{2}\): .*\(#117\)$/m.test(readme),
    "archive-work 2.7.0, plugin 4.7.0 and the README changelog carry a line for #117",
  );

  console.log("\nAll merge SHA skill and docs tests passed.");
}

run();
