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
  // Minimums, not the current versions: a later release moves them (PROJECT_LORE).
  const atLeast = (v: string, min: string) => {
    const [a, b] = [v, min].map((x) => x.split(".").map(Number));
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    return true;
  };
  const current = /^\*\*Current:\*\* (\d+\.\d+\.\d+)$/m.exec(readme)?.[1] ?? "0.0.0";
  assert(
    atLeast(/^\*\*Version:\*\* (\d+\.\d+\.\d+)$/m.exec(skill)?.[1] ?? "0.0.0", "2.7.0") &&
      /^- v2\.7\.0: .*\(#117\)$/m.test(skill) &&
      atLeast(JSON.parse(read(".claude-plugin/plugin.json")).version, "4.7.0") &&
      atLeast(current, "4.7.0") &&
      /^- 4\.7\.0 \(\d{4}-\d{2}-\d{2}\): .*\(#117\)$/m.test(readme),
    "archive-work at least 2.7.0, a plugin and README Current of at least 4.7.0, and the README changelog carry a line for #117",
  );

  console.log("\nThe docs (#117)\n");
  const design = read("docs/FACTORY_DESIGN.md");
  const cli = read("docs/FACTORY_CLI.md");
  const s71 = between(design, "### 7.1 Tables", "### 7.2 ");
  const s72 = between(design, "### 7.2 Event conventions", "### 7.3 ");
  const s9 = between(design, "## 9. Changes to Existing Skills", "## 10. ");
  const stage9 = design.split("\n").find((l) => l.startsWith("| 9 | Merge")) ?? "";
  const runFields = cli.split("\n").find((l) => l.includes("`archive_path` (set by archive)")) ?? "";
  const archiveDoc = between(cli, "### archive", "### backfill-merge-shas");
  assert(
    s71.includes("*As built (#117): the merge SHA.*") &&
      s71.includes("`factory archive --close`") &&
      s71.includes("`factory backfill-merge-shas [run_id]`") &&
      s71.includes("**Limits.**"),
    "FACTORY_DESIGN.md section 7.1 has an as-built note (#117) for merge_sha: the close, the backfill and its limits",
  );
  assert(
    s72.includes("*As built (#117):*") &&
      s72.includes("`factory reverts`") &&
      s72.includes("This reverts commit") &&
      /never fetches/.test(s72) &&
      /squash merge/.test(s72) &&
      /rebase merge/.test(s72),
    "FACTORY_DESIGN.md section 7.2 describes the revert event as built, with how it is found and the squash and rebase limit",
  );
  assert(
    s9.includes("#117, merge SHA recording") && !s9.includes("merge SHA recording still next"),
    "FACTORY_DESIGN.md section 9 records merge SHA recording as built (#117) and drops it from still next",
  );
  assert(
    cli.includes("### backfill-merge-shas") &&
      cli.includes("### reverts") &&
      (cli.match(/\*\*No database\.\*\* It answers an empty result/g) ?? []).length === 2 &&
      cli.includes("- **archive:** `{run_id, archive_path, changed, closed, operator_action, merge_sha,") &&
      cli.includes("One `revert` event per run and revert commit") &&
      archiveDoc.includes("**The merge SHA (#117).**") &&
      !cli.includes("recorded later (manifest-sync)"),
    "FACTORY_CLI.md documents backfill-merge-shas, reverts (including the no-database result), the archive merge_sha result and the revert event, and its archive bullet no longer says the merge commit is recorded later",
  );
  assert(
    /`merge_sha` \(the PR's merge commit, set by `archive --close` and by `backfill-merge-shas`/.test(runFields) && !runFields.includes("manifest-sync"),
    "FACTORY_CLI.md's run table fields say archive --close and the backfill set merge_sha, not manifest-sync",
  );
  assert(
    stage9.includes("`archive --close`") && !stage9.includes("manifest-sync"),
    "FACTORY_DESIGN.md section 2's stage table says the close records the merge SHA, not manifest-sync",
  );

  console.log("\nAll merge SHA skill and docs tests passed.");
}

run();
