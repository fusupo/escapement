/**
 * Escapement's own test runner, the `verify` command of its factory
 * settings (#65): run every test suite one after another, never in
 * parallel, and write JUnit XML so contract `test` selectors can name single
 * assertions.
 *
 *   bash scripts/run-tests.sh [--junit <path>] [suite ...]
 *
 * - Suites, in this order: manifest/test-*.ts (node --import tsx, cwd
 *   manifest/), scripts/test-*.sh (bash), scripts/test-*.py (python3).
 *   Naming suites (paths from the repo root) runs only those.
 * - Each `  ✓ <message>` (or `  OK: <message>`) line a TypeScript suite
 *   prints becomes a passing
 *   testcase named <message>, in a testsuite whose `file` is the suite's
 *   path, so `manifest/test-factory-pr.ts::<message>` selects it. A trailing
 *   ` (SomeError: …)` that `throws()` appends is moved out of the name: it
 *   varies from run to run.
 * - A suite that exits non-zero gets a failing testcase carrying its FAIL
 *   line (or the end of its output). A TypeScript suite that exits 0 but
 *   reports no `✓` fails too: it tested nothing.
 * - A bash or python suite is one testcase, named after the file.
 * - Children get a throwaway ESCAPEMENT_MANIFEST_DIR and XDG_CONFIG_HOME,
 *   and no agent token or fault injection settings, so a factory run's own
 *   environment never reaches the tests.
 * - Output: every suite's output, a summary, and the XML at --junit (else
 *   $FACTORY_RESULTS_DIR/junit.xml when set). Exit 1 if any suite failed.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SuiteKind = "ts" | "sh" | "py";
export type Suite = { path: string; kind: SuiteKind };
export type CaseResult = { name: string; failure: string | null; detail: string | null };
export type SuiteResult = { suite: Suite; exitCode: number | null; durationS: number; cases: CaseResult[] };

const PASS_LINE = /^\s*(?:✓|OK:) (.+?)\s*$/;
const THROWN = /^(.+?) \(((?:[A-Za-z]+)?Error\b.*)\)$/s;

/** The suites under `root`, in run order. */
export function discoverSuites(root: string): Suite[] {
  const list = (dir: string, re: RegExp, kind: SuiteKind) => {
    let names: string[] = [];
    try {
      names = readdirSync(join(root, dir));
    } catch {
      return [];
    }
    return names
      .filter((n) => re.test(n))
      .sort()
      .map((n) => ({ path: `${dir}/${n}`, kind }));
  };
  return [
    ...list("manifest", /^test-.*\.ts$/, "ts"),
    ...list("scripts", /^test-.*\.sh$/, "sh"),
    ...list("scripts", /^test-.*\.py$/, "py"),
  ];
}

export function suiteFor(path: string): Suite {
  const p = path.replace(/^\.\//, "");
  const kind: SuiteKind | null = p.endsWith(".ts") ? "ts" : p.endsWith(".sh") ? "sh" : p.endsWith(".py") ? "py" : null;
  if (!kind) throw new Error(`not a test suite: ${path} (.ts, .sh or .py)`);
  return { path: p, kind };
}

/** Testcases from one suite's output and exit status. */
export function casesFrom(suite: Suite, output: string, exitCode: number | null): CaseResult[] {
  const cases: CaseResult[] = [];
  if (suite.kind === "ts") {
    for (const line of output.split("\n")) {
      const m = line.match(PASS_LINE);
      if (!m) continue;
      const thrown = m[1].match(THROWN);
      cases.push(thrown ? { name: thrown[1], failure: null, detail: thrown[2] } : { name: m[1], failure: null, detail: null });
    }
  }
  const failed = exitCode !== 0;
  if (suite.kind !== "ts") {
    cases.push({ name: suite.path.split("/").pop()!, failure: failed ? failureText(output, exitCode) : null, detail: summaryLine(output) });
  } else if (failed) {
    cases.push({ name: "suite failed", failure: failureText(output, exitCode), detail: null });
  } else if (cases.length === 0) {
    cases.push({ name: "suite reported no assertions", failure: "exited 0 without printing a single ✓ or OK: line", detail: null });
  }
  return cases;
}

function summaryLine(output: string): string | null {
  return output.split("\n").reverse().find((l) => /\d+ passed, \d+ failed/.test(l))?.trim() ?? null;
}

function failureText(output: string, exitCode: number | null): string {
  const lines = output.split("\n");
  const fails = lines.filter((l) => /\bFAIL\b/.test(l)).slice(0, 20);
  const tail = lines.filter((l) => l.trim()).slice(-15);
  const status = exitCode === null ? "killed by a signal" : `exit ${exitCode}`;
  return `${status}\n${(fails.length ? fails : tail).join("\n")}`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML 1.0 forbids most control characters, even escaped.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

export function junitXml(results: SuiteResult[]): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const total = results.reduce((n, r) => n + r.cases.length, 0);
  const failures = results.reduce((n, r) => n + r.cases.filter((c) => c.failure).length, 0);
  out.push(`<testsuites name="escapement" tests="${total}" failures="${failures}">`);
  for (const r of results) {
    const f = xmlEscape(r.suite.path);
    const fails = r.cases.filter((c) => c.failure).length;
    out.push(`  <testsuite name="${f}" file="${f}" tests="${r.cases.length}" failures="${fails}" time="${r.durationS.toFixed(3)}">`);
    for (const c of r.cases) {
      const open = `    <testcase classname="${f}" file="${f}" name="${xmlEscape(c.name)}"`;
      const body = [
        c.failure ? `      <failure message="${xmlEscape(c.failure.split("\n")[0])}">${xmlEscape(c.failure)}</failure>` : null,
        c.detail ? `      <system-out>${xmlEscape(c.detail)}</system-out>` : null,
      ].filter(Boolean);
      out.push(body.length ? `${open}>\n${body.join("\n")}\n    </testcase>` : `${open}/>`);
    }
    out.push("  </testsuite>");
  }
  out.push("</testsuites>", "");
  return out.join("\n");
}

/** The environment a suite runs in: nothing from a factory run or the user's agent identity. */
export function suiteEnv(base: NodeJS.ProcessEnv, scratch: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ESCAPEMENT_MANIFEST_DIR: join(scratch, "data"), XDG_CONFIG_HOME: join(scratch, "config") };
  for (const k of Object.keys(env)) {
    if (k.startsWith("ESCAPEMENT_AGENT_") || k.startsWith("ESCAPEMENT_FACTORY_FAULT") || k === "GH_TOKEN" || k === "GITHUB_TOKEN") delete env[k];
  }
  return env;
}

function command(root: string, s: Suite): { argv: string[]; cwd: string } {
  if (s.kind === "ts") return { argv: [process.execPath, "--import", "tsx", relative(join(root, "manifest"), join(root, s.path))], cwd: join(root, "manifest") };
  if (s.kind === "sh") return { argv: ["bash", s.path], cwd: root };
  return { argv: ["python3", s.path], cwd: root };
}

async function runSuite(root: string, s: Suite, env: NodeJS.ProcessEnv): Promise<SuiteResult> {
  const { argv, cwd } = command(root, s);
  const started = Date.now();
  const chunks: Buffer[] = [];
  const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const take = (b: Buffer, to: NodeJS.WriteStream) => {
    chunks.push(b);
    to.write(b);
  };
  child.stdout.on("data", (b: Buffer) => take(b, process.stdout));
  child.stderr.on("data", (b: Buffer) => take(b, process.stderr));
  const exitCode = await new Promise<number | null>((done) => {
    child.on("error", (err) => {
      chunks.push(Buffer.from(`run-suites: failed to start ${argv[0]}: ${err.message}\n`));
      done(127);
    });
    child.on("close", (code) => done(code));
  });
  const output = Buffer.concat(chunks).toString("utf-8");
  return { suite: s, exitCode, durationS: (Date.now() - started) / 1000, cases: casesFrom(s, output, exitCode) };
}

async function main(argv: string[]): Promise<number> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let junit: string | null = process.env.FACTORY_RESULTS_DIR ? join(process.env.FACTORY_RESULTS_DIR, "junit.xml") : null;
  const named: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--junit") junit = resolve(argv[++i] ?? "");
    else named.push(argv[i]);
  }
  const suites = named.length ? named.map(suiteFor) : discoverSuites(root);
  const scratch = mkdtempSync(join(tmpdir(), "escapement-suites-"));
  const results: SuiteResult[] = [];
  try {
    for (const s of suites) {
      process.stdout.write(`\n━━ ${s.path}\n`);
      // Each suite gets its own data and config dirs.
      const dir = mkdtempSync(join(scratch, "s-"));
      results.push(await runSuite(root, s, suiteEnv(process.env, dir)));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (junit) {
    mkdirSync(dirname(junit), { recursive: true });
    writeFileSync(junit, junitXml(results));
  }
  const failed = results.filter((r) => r.cases.some((c) => c.failure));
  process.stdout.write("\n━━ summary\n");
  for (const r of results) {
    const n = r.cases.length;
    process.stdout.write(`${r.cases.some((c) => c.failure) ? "FAIL" : "ok  "} ${r.suite.path} (${n} case${n === 1 ? "" : "s"}, ${r.durationS.toFixed(1)}s)\n`);
  }
  process.stdout.write(`${results.length - failed.length} of ${results.length} suites passed${junit ? `; JUnit: ${junit}` : ""}\n`);
  return failed.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`run-suites: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    },
  );
}
