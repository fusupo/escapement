// Agent-assisted manual checks (#103): the validate-work text that carries
// out a manual check and leaves the outcome to the operator, and the
// archive-work copy list that keeps the attachments and, since #101, the
// plan critique.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
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

  // #120 (from #107): the walk-through's four gaps.
  assert(
    s5.includes("`mcp__plugin_escapement_playwright__*`") &&
      s5.includes("never a page fetch or `curl`") &&
      s5.includes("unless the instructions name the shell"),
    "validate-work browser steps use the bundled Playwright tools and never a page fetch or curl unless the instructions name the shell",
  );
  const override = s6.indexOf("**`PLAYWRIGHT_BROWSERS_PATH` is set**");
  const otherwise = s6.indexOf("**Otherwise:**");
  const pinned = s6.indexOf("npx -y @playwright/mcp@0.0.84 install-browser chrome-for-testing");
  assert(
    override >= 0 &&
      otherwise > override &&
      pinned > otherwise &&
      /name it as the likely cause/.test(s6.slice(override, otherwise)) &&
      !s6.slice(override, otherwise).includes("npx ") &&
      s6.includes("Record nothing") &&
      s6.includes("Either way, record nothing"),
    "validate-work names PLAYWRIGHT_BROWSERS_PATH as the likely cause of a missing browser when it is set, else the pinned install command, and either way records nothing",
  );
  const stopBullet = phase1.split("\n").find((l) => l.startsWith("- **`.result.matched` is false")) ?? "";
  assert(
    stopBullet.includes("except for manual checks") && stopBullet.includes("report the reasons and stop"),
    "validate-work Phase 1 says a missing match stops everything except manual checks",
  );
  assert(/^tools:\n(?:  - .*\n)*  - AskUserQuestion\n/m.test(front + "\n"), "validate-work lists AskUserQuestion in its frontmatter tools");
  const atLeast = (v: string, min: string) => {
    const [a, b] = [v, min].map((x) => x.split(".").map(Number));
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    return true;
  };
  const version = /^\*\*Version:\*\* (\d+\.\d+\.\d+)$/m.exec(skill)?.[1] ?? "0.0.0";
  assert(atLeast(version, "1.5.1"), "validate-work is at least version 1.5.1");
  assert(/^- v1\.5\.1: .*PLAYWRIGHT_BROWSERS_PATH.*\(#120[,)]/m.test(skill), "validate-work has a 1.5.1 changelog line for issue 120");
}

/** Every file under `dir`, as sorted paths relative to it. */
function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Runs Phase 6.5 step 1's copy block, as the skill writes it, on an artifact
 * dir holding `fixture`. Returns the exit status and what landed in DEST.
 */
function runCopy(block: string, fixture: string[]): { status: number | null; copied: string[] } {
  const tmp = mkdtempSync(join(tmpdir(), "archive-copy-"));
  try {
    const art = join(tmp, "artifacts");
    for (const f of fixture) {
      mkdirSync(dirname(join(art, f)), { recursive: true });
      writeFileSync(join(art, f), f);
    }
    const archive = join(tmp, "archive");
    const runId = "owner-repo#42-r1";
    const script = block.replaceAll("{artifact_dir}", art).replaceAll("{run_id}", runId);
    const r = spawnSync("bash", ["-c", script], { env: { ...process.env, ARCHIVE_DIR: archive }, encoding: "utf-8" });
    const dest = join(archive, "runs", runId);
    let copied: string[] = [];
    try {
      copied = files(dest);
    } catch {
      copied = [];
    }
    return { status: r.status, copied };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function archiveWork() {
  console.log("\narchive-work: the run's copied artifacts\n");
  const skill = read("skills/archive-work/SKILL.md");
  const phase = section(skill, "### Phase 6.5: Archive the Factory Run");
  const find = phase.match(/find \. -type f \\\((.*?)\\\)\)/)?.[1] ?? "";
  assert(find.includes("-path ./critique.json"), "archive-work's Phase 6.5 copy list includes critique.json");

  // Step 1's copy block only: step 2's block runs the factory runner.
  const s1 = phase.slice(phase.indexOf("1. **Copy**"), phase.indexOf("2. **Record it"));
  const block = s1.match(/```bash\n([\s\S]*?)```/)?.[1] ?? "";
  const kept = [
    "contract.json",
    "review.json",
    "report.json",
    "report.r2.json",
    "pr/body.md",
    "manual/AC-1.e1/observations.md",
  ];
  const withCritique = runCopy(block, [...kept, "critique.json", "logs/x.log"]);
  const without = runCopy(block, [...kept, "logs/x.log"]);
  assert(
    block.includes("find .") &&
      !block.includes("factory") &&
      withCritique.status === 0 &&
      withCritique.copied.includes("critique.json") &&
      without.status === 0 &&
      without.copied.length > 0 &&
      !without.copied.includes("critique.json"),
    "archive-work's Phase 6.5 copy command copies critique.json when present and succeeds without it",
  );
  assert(
    JSON.stringify(withCritique.copied) === JSON.stringify([...kept, "critique.json"].sort()) &&
      JSON.stringify(without.copied) === JSON.stringify([...kept].sort()),
    "archive-work's Phase 6.5 copy command keeps the other run artifacts and leaves out logs",
  );

  assert(
    find.includes("-path './manual/*'") &&
      find.includes("-name contract.json") &&
      find.includes("-path ./pr/body.md") &&
      !find.includes("logs"),
    "archive-work's Phase 6.5 copy list includes the manual attachments",
  );

  // The prose, not the find list in the fenced block, has to name it.
  const prose = phase.replace(/```[\s\S]*?```/g, "");
  const previewAt = skill.indexOf("With a factory run (Phase 2, step 5), also show:");
  const open = skill.indexOf("```", previewAt);
  const preview = previewAt < 0 || open < 0 ? "" : skill.slice(previewAt, skill.indexOf("```", open + 3));
  const changelog = skill.slice(skill.indexOf("**Changelog:**"));
  assert(
    /critique\.json|plan critique/.test(prose) &&
      preview.includes("plan critique") &&
      changelog.split("\n").some((l) => l.startsWith("- v") && l.includes("#101") && l.includes("critique")),
    "archive-work's SKILL.md names the plan critique outside the copy command: Phase 6.5 prose, the Phase 5 preview and the changelog",
  );
}

validateWork();
archiveWork();
console.log("\nAll manual-assist skill tests passed.");
