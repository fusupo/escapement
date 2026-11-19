// The docs and release of the reviewer leftovers batch (#120): each behaviour
// change is described in FACTORY_CLI.md and has an as-built note in
// FACTORY_DESIGN.md, and the release is cut.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./factory/testkit.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf-8");

/** The text of a `### ` section, up to the next `## ` or `### ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n#{2,3} /);
  return text.slice(start, next < 0 ? undefined : start + heading.length + next);
}

function cliDocs() {
  console.log("FACTORY_CLI.md\n");
  const cli = read("docs/FACTORY_CLI.md");
  const cont = section(cli, "### continue");
  const flagRow = cli.split("\n").find((l) => l.startsWith("| `--run-budget <dur>` |")) ?? "";
  assert(
    /`--run-budget` on a run without a PR is a `usage` error too \(#120\)/.test(cont) &&
      /On a run without a PR, which gets no new deadline, `--run-budget` is a `usage` error \(#120\)/.test(cont) &&
      flagRow.includes("a `usage` error on a run without one, #120"),
    "FACTORY_CLI.md says continue --run-budget on a run without a PR is a usage error",
  );
  const backfill = section(cli, "### backfill-merge-shas");
  const shape = cli.split("\n").find((l) => l.startsWith("- **backfill-merge-shas:**")) ?? "";
  assert(
    backfill.includes("**A gh failure stops it (#120).**") &&
      backfill.includes("the fills already made are kept") &&
      backfill.includes("every run still waiting") &&
      backfill.includes("`{filled, skipped, failed: {run_id, pr_number}, waiting: [{run_id, pr_number}]}`") &&
      shape.includes("`gh_failed` with `error.detail` `{filled, skipped, failed, waiting}` (#120)"),
    "FACTORY_CLI.md says backfill-merge-shas keeps its fills and reports the failure, the runs still waiting and the skipped ones",
  );
  const manual = section(cli, "### record-manual");
  assert(
    manual.includes('"…, validated again on the same head (attempt {m})" (#120)') &&
      manual.includes("the head moved") &&
      manual.includes("The redo line names whether the head moved or the same head was validated again."),
    "FACTORY_CLI.md says the redo line names whether the head moved or the same head was validated again",
  );
}

function designDocs() {
  console.log("\nFACTORY_DESIGN.md\n");
  const design = read("docs/FACTORY_DESIGN.md");
  const s47 = section(design, "### 4.7 Run state machine");
  assert(
    s47.includes("*As built (#120): the continue --run-budget refusal.*") && /`continue --run-budget` on a run without a PR[^\n]*a `usage` error/.test(s47),
    "FACTORY_DESIGN.md has an as built note for 120 on the continue --run-budget refusal",
  );
  const s71 = section(design, "### 7.1 Tables");
  assert(
    s71.includes("*As built (#120): the backfill failure report.*") &&
      /fills already made are kept/.test(s71) &&
      /every run still waiting/.test(s71),
    "FACTORY_DESIGN.md has an as built note for 120 on the backfill failure report",
  );
  const s55 = section(design, "### 5.5 Completing manual evidence");
  assert(
    s55.includes("*As built (#120): the redo line wording.*") && s55.includes("validated again on the same head (attempt {m})"),
    "FACTORY_DESIGN.md has an as built note for 120 on the redo line wording",
  );
}

function pushUrlDocs() {
  console.log("\nThe push URL check\n");
  const cli = read("docs/FACTORY_CLI.md");
  const github = section(cli, "### GitHub and the agent identity");
  const push = section(cli, "### push");
  const s48 = section(read("docs/FACTORY_DESIGN.md"), "### 4.8 Idempotent PR creation");
  assert(
    github.includes("**A remote named after the push URL** (#120)") &&
      github.includes("in any config scope") &&
      push.includes("a remote named after the push URL (#120)") &&
      s48.includes("*As built (#120): a remote named by the URL.*") &&
      s48.includes("The push URL check covers a remote named by the URL"),
    "FACTORY_CLI.md and FACTORY_DESIGN.md say the push URL check covers a remote named by the URL",
  );
}

try {
  cliDocs();
  designDocs();
  pushUrlDocs();
  console.log("\nAll #120 docs checks passed.");
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
