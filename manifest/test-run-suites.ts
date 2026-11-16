import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { casesFrom, discoverSuites, junitXml, suiteEnv, suiteFor, type SuiteResult } from "./run-suites.ts";
import { parseJUnit, resolveSelector } from "./factory/junit.ts";
import { assert, throws, cleanup, tempDir } from "./factory/testkit.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run() {
  console.log("run-suites: Escapement's verify, as JUnit\n");

  const fake = tempDir();
  for (const f of ["manifest/test-b.ts", "manifest/test-a.ts", "manifest/helper.ts", "scripts/test-z.sh", "scripts/test-y.py", "scripts/run-tests.sh"]) {
    mkdirSync(dirname(join(fake, f)), { recursive: true });
    writeFileSync(join(fake, f), "");
  }
  assert(
    discoverSuites(fake).map((s) => s.path).join() === "manifest/test-a.ts,manifest/test-b.ts,scripts/test-z.sh,scripts/test-y.py",
    "suites: TypeScript, then bash, then python, each sorted; helpers and run-tests.sh aren't suites",
  );
  assert(suiteFor("./scripts/test-z.sh").kind === "sh", "a named suite is typed by its extension");
  throws(() => suiteFor("README.md"), /not a test suite/, "a named file that isn't a suite is refused");

  const ts = suiteFor("manifest/test-a.ts");
  const out = "Title\n\n  ✓ it works\n  ✓ refuses junk (FactoryError: run #1-r1 passed its deadline (2026-11-16T21:13:15.751Z))\nnot a case ✓ here\n";
  const cases = casesFrom(ts, out, 0);
  assert(cases.length === 2 && cases[0].name === "it works" && cases.every((c) => c.failure === null), "each ✓ line is a passing case");
  assert(cases[1].name === "refuses junk" && /^FactoryError: run #1-r1/.test(cases[1].detail ?? ""), "the error throws() appends is moved out of the name");
  const failed = casesFrom(ts, `${out}Error: FAIL: the rerun finds that PR\n    at assert\n`, 1);
  assert(failed.at(-1)!.name === "suite failed" && /exit 1\nError: FAIL: the rerun finds that PR/.test(failed.at(-1)!.failure ?? ""), "a failing suite adds a failed case with its FAIL line");
  assert(casesFrom(ts, "nothing here\n", 0)[0].failure !== null, "a suite that exits 0 with no ✓ fails: it tested nothing");
  assert(casesFrom(ts, "  OK: m#1 state is 'done'\n", 0)[0].name === "m#1 state is 'done'", "OK: lines (the older suites) count as passing cases too");
  const sh = casesFrom(suiteFor("scripts/test-z.sh"), "FAIL crash-pr\n    status=1\n103 passed, 1 failed\n", 1);
  assert(sh.length === 1 && sh[0].name === "test-z.sh" && /FAIL crash-pr/.test(sh[0].failure ?? "") && sh[0].detail === "103 passed, 1 failed", "a bash suite is one case, failed with its FAIL lines");

  const results: SuiteResult[] = [
    { suite: ts, exitCode: 0, durationS: 1.5, cases },
    { suite: suiteFor("scripts/test-z.sh"), exitCode: 1, durationS: 2, cases: sh },
  ];
  const xml = junitXml(results);
  const parsed = parseJUnit(xml, "run-suites.xml");
  assert(parsed.length === 3 && parsed.every((c) => c.file !== null), "the XML parses with the factory's JUnit reader, every case located");
  const hit = resolveSelector("manifest/test-a.ts::refuses junk", parsed);
  assert(hit.executed === "passed" && hit.cases.length === 1, "a contract selector path::assertion resolves to that case");
  assert(resolveSelector("manifest/test-a.ts", parsed).executed === "passed", "a bare suite path selects all of its cases");
  assert(resolveSelector("scripts/test-z.sh", parsed).executed === "failed", "a failed bash suite resolves as failed");
  assert(resolveSelector("manifest/test-a.ts::no such check", parsed).executed === "not_found", "an assertion that isn't printed is not_found");
  const nasty = junitXml([{ suite: ts, exitCode: 0, durationS: 0, cases: [{ name: 'a <b> & "c" \u0001', failure: null, detail: null }] }]);
  assert(parseJUnit(nasty)[0].name === 'a <b> & "c" ', "names are escaped (control characters dropped)");

  const env = suiteEnv(
    { PATH: "/bin", ESCAPEMENT_AGENT_GH_TOKEN: "t", ESCAPEMENT_FACTORY_FAULT: "pr.created", ESCAPEMENT_FACTORY_FAULT_DIR: "/x", GH_TOKEN: "t", GITHUB_TOKEN: "t" },
    "/scratch",
  );
  assert(
    env.PATH === "/bin" && env.ESCAPEMENT_MANIFEST_DIR === "/scratch/data" && env.XDG_CONFIG_HOME === "/scratch/config" &&
      !("ESCAPEMENT_AGENT_GH_TOKEN" in env) && !("ESCAPEMENT_FACTORY_FAULT" in env) && !("ESCAPEMENT_FACTORY_FAULT_DIR" in env) && !("GH_TOKEN" in env) && !("GITHUB_TOKEN" in env),
    "suites never see the run's tokens, faults or real data dirs",
  );

  // The real wrapper on one real suite, with an armed fault in the environment.
  const junit = join(tempDir(), "out", "junit.xml");
  const r = spawnSync("bash", [join(root, "scripts/run-tests.sh"), "--junit", junit, "manifest/test-factory-fault.ts"], {
    encoding: "utf-8",
    env: { ...process.env, ESCAPEMENT_FACTORY_FAULT: "pr.created" },
  });
  const real = parseJUnit(readFileSync(junit, "utf-8"));
  assert(r.status === 0 && /1 of 1 suites passed/.test(r.stdout), "run-tests.sh runs a named suite and exits 0");
  assert(real.length > 5 && real.every((c) => c.file === "manifest/test-factory-fault.ts" && c.status === "passed"), "its JUnit lists the suite's assertions as passing cases");

  cleanup();
  console.log("\nAll run-suites tests passed.");
}

try {
  run();
} catch (err) {
  console.error(err);
  cleanup();
  process.exit(1);
}
