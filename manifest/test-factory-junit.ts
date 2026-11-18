import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseJUnit, readResults, resultFiles, resolveSelector, parseSelector, executedCount } from "./factory/junit.ts";
import { assert, throws, tempDir, cleanup } from "./factory/testkit.ts";

/** What jest-junit writes with addFileAttribute on (default class/title templates). */
const JEST = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="jest tests" tests="4" failures="1" errors="0" time="1.2">
  <testsuite name="refresh" errors="0" failures="1" skipped="1" tests="4" time="1.1">
    <testcase classname="refresh refreshes valid token" name="refresh refreshes valid token" time="0.01" file="/work/repo/tests/auth/refresh.test.ts">
    </testcase>
    <testcase classname="refresh rejects expired token" name="refresh rejects expired token" time="0.02" file="/work/repo/tests/auth/refresh.test.ts">
      <failure message="expected 401 &amp; got 500"><![CDATA[Error: expect(received).toBe(expected)
Expected: 401
Received: 500]]></failure>
    </testcase>
    <testcase classname="refresh later" name="refresh later" time="0" file="/work/repo/tests/auth/refresh.test.ts">
      <skipped/>
    </testcase>
    <testcase classname="refresh nested &lt;edge&gt;" name="refresh nested &lt;edge&gt;" time="0" file="/work/repo/tests/auth/refresh.test.ts"/>
  </testsuite>
</testsuites>`;

/** pytest (xunit2): no file attribute, dotted classnames, a lone testsuite inside testsuites. */
const PYTEST = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="1" failures="0" skipped="0" tests="2">
<testcase classname="tests.test_auth.TestRefresh" name="test_rejects_expired" time="0.001"/>
<testcase classname="tests.test_auth" name="test_boom" time="0.001"><error message="fixture failed">trace</error></testcase>
</testsuite></testsuites>`;

/** vitest: the classname and suite name are the file path. A lone <testsuite> root, nested suites. */
const VITEST = `<testsuite name="src/math.test.ts" tests="2">
  <testsuite name="add">
    <testcase classname="src/math.test.ts" name="add &gt; adds numbers"/>
    <testcase classname="src/math.test.ts" name="add &gt; adds zero"/>
  </testsuite>
</testsuite>`;

/** node:test's junit reporter (Node 22): top-level tests directly under <testsuites>, no file, classname "test". */
const NODE_TEST = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testcase name="refreshes a valid token" time="0.0004" classname="test"/>
	<testcase name="rejects an expired token" time="0.0001" classname="test">
		<failure type="testCodeFailure" message="Expected values to be strictly equal">trace</failure>
	</testcase>
	<testsuite name="refresh" time="0.001" disabled="0" errors="0" tests="1" failures="0" skipped="0" hostname="h">
		<testcase name="keeps the id" time="0.0001" classname="test"/>
	</testsuite>
	<!-- tests 3 -->
</testsuites>`;

/**
 * Playwright Test 1.64.1's junit reporter, captured from a real run (the scratch
 * path replaced by /work/repo). playwright.config.ts at the repo root, with
 * `testDir: 'e2e'` on its one project and `retries: 2`: suite name and
 * classname are the file path from the config's rootDir, no file attribute,
 * names are `Describe › title`. "settles after a retry" failed once, then passed.
 */
const PLAYWRIGHT = `<testsuites id="" name="" tests="5" failures="1" skipped="1" errors="0" time="1.20743">
<testsuite name="e2e/graph.spec.ts" timestamp="2026-11-18T18:58:15.274Z" hostname="chromium" tests="5" failures="1" skipped="1" time="0.011" errors="0">
<testcase name="Graph › adds a node" classname="e2e/graph.spec.ts" time="0.002">
</testcase>
<testcase name="Graph › rejects a bad edge" classname="e2e/graph.spec.ts" time="0.007">
<system-out>
<![CDATA[
[[ATTACHMENT|out/root/graph-Graph-rejects-a-bad-edge-chromium/error-context.md]]

[[ATTACHMENT|out/root/graph-Graph-rejects-a-bad-edge-chromium-retry1/error-context.md]]

[[ATTACHMENT|out/root/graph-Graph-rejects-a-bad-edge-chromium-retry2/error-context.md]]
]]>
</system-out>
<failure message="expect(received).toBe(expected) // Object.is equality" type="expect.toBe">
<![CDATA[  [chromium] › e2e/graph.spec.ts:9:7 › Graph › rejects a bad edge ──────────────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 3
    Received: 2

       8 |   })
       9 |   test('rejects a bad edge', () => {
    > 10 |     expect(1 + 1).toBe(3)
         |                   ^
      11 |   })
      12 |   test.skip('draws later', () => {})
      13 | })
        at /work/repo/e2e/graph.spec.ts:10:19

    Error Context: ../out/root/graph-Graph-rejects-a-bad-edge-chromium/error-context.md

    Retry #1 ───────────────────────────────────────────────────────────────────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 3
    Received: 2

       8 |   })
       9 |   test('rejects a bad edge', () => {
    > 10 |     expect(1 + 1).toBe(3)
         |                   ^
      11 |   })
      12 |   test.skip('draws later', () => {})
      13 | })
        at /work/repo/e2e/graph.spec.ts:10:19

    Error Context: ../out/root/graph-Graph-rejects-a-bad-edge-chromium-retry1/error-context.md

    Retry #2 ───────────────────────────────────────────────────────────────────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 3
    Received: 2

       8 |   })
       9 |   test('rejects a bad edge', () => {
    > 10 |     expect(1 + 1).toBe(3)
         |                   ^
      11 |   })
      12 |   test.skip('draws later', () => {})
      13 | })
        at /work/repo/e2e/graph.spec.ts:10:19

    Error Context: ../out/root/graph-Graph-rejects-a-bad-edge-chromium-retry2/error-context.md
]]>
</failure>
</testcase>
<testcase name="Graph › draws later" classname="e2e/graph.spec.ts">
<properties>
<property name="skip" value="">
</property>
</properties>
<skipped>
</skipped>
</testcase>
<testcase name="opens the editor" classname="e2e/graph.spec.ts" time="0.002">
</testcase>
<testcase name="settles after a retry" classname="e2e/graph.spec.ts" time="0">
<system-out>
<![CDATA[
[[ATTACHMENT|out/root/graph-settles-after-a-retry-chromium/error-context.md]]
]]>
</system-out>
</testcase>
</testsuite>
</testsuites>`;

/** The same run with a top-level `testDir: 'e2e'`: rootDir is e2e/, so the classname drops the folder. */
const PLAYWRIGHT_SUBDIR = `<testsuites id="" name="" tests="5" failures="1" skipped="1" errors="0" time="1.177016">
<testsuite name="graph.spec.ts" timestamp="2026-11-18T18:58:16.789Z" hostname="chromium" tests="5" failures="1" skipped="1" time="0.012" errors="0">
<testcase name="Graph › adds a node" classname="graph.spec.ts" time="0.002">
</testcase>
<testcase name="Graph › rejects a bad edge" classname="graph.spec.ts" time="0.007">
<system-out>
<![CDATA[
[[ATTACHMENT|out/sub/graph-Graph-rejects-a-bad-edge-chromium/error-context.md]]

[[ATTACHMENT|out/sub/graph-Graph-rejects-a-bad-edge-chromium-retry1/error-context.md]]

[[ATTACHMENT|out/sub/graph-Graph-rejects-a-bad-edge-chromium-retry2/error-context.md]]
]]>
</system-out>
<failure message="expect(received).toBe(expected) // Object.is equality" type="expect.toBe">
<![CDATA[  [chromium] › graph.spec.ts:9:7 › Graph › rejects a bad edge ──────────────────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 3
    Received: 2

       8 |   })
       9 |   test('rejects a bad edge', () => {
    > 10 |     expect(1 + 1).toBe(3)
         |                   ^
      11 |   })
      12 |   test.skip('draws later', () => {})
      13 | })
        at /work/repo/e2e/graph.spec.ts:10:19

    Error Context: ../../out/sub/graph-Graph-rejects-a-bad-edge-chromium/error-context.md

    Retry #1 ───────────────────────────────────────────────────────────────────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 3
    Received: 2

       8 |   })
       9 |   test('rejects a bad edge', () => {
    > 10 |     expect(1 + 1).toBe(3)
         |                   ^
      11 |   })
      12 |   test.skip('draws later', () => {})
      13 | })
        at /work/repo/e2e/graph.spec.ts:10:19

    Error Context: ../../out/sub/graph-Graph-rejects-a-bad-edge-chromium-retry1/error-context.md

    Retry #2 ───────────────────────────────────────────────────────────────────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 3
    Received: 2

       8 |   })
       9 |   test('rejects a bad edge', () => {
    > 10 |     expect(1 + 1).toBe(3)
         |                   ^
      11 |   })
      12 |   test.skip('draws later', () => {})
      13 | })
        at /work/repo/e2e/graph.spec.ts:10:19

    Error Context: ../../out/sub/graph-Graph-rejects-a-bad-edge-chromium-retry2/error-context.md
]]>
</failure>
</testcase>
<testcase name="Graph › draws later" classname="graph.spec.ts">
<properties>
<property name="skip" value="">
</property>
</properties>
<skipped>
</skipped>
</testcase>
<testcase name="opens the editor" classname="graph.spec.ts" time="0.002">
</testcase>
<testcase name="settles after a retry" classname="graph.spec.ts" time="0.001">
<system-out>
<![CDATA[
[[ATTACHMENT|out/sub/graph-settles-after-a-retry-chromium/error-context.md]]
]]>
</system-out>
</testcase>
</testsuite>
</testsuites>`;

function run() {
  console.log("Parsing\n");

  const jest = parseJUnit(JEST, "jest.xml");
  assert(jest.length === 4, "every testcase is read");
  assert(jest.map((c) => c.status).join() === "passed,failed,skipped,passed", "passed, failed (failure child) and skipped (skipped child)");
  assert(jest[1].message === "expected 401 & got 500", "the failure message attribute, entities decoded");
  assert(jest[3].name === "refresh nested <edge>", "entities in attributes are decoded");
  assert(jest[0].file === "/work/repo/tests/auth/refresh.test.ts" && jest[0].suites.join() === "refresh", "file and suite names");

  const py = parseJUnit(PYTEST);
  assert(py[1].status === "error" && py[1].message === "fixture failed" && py[1].file === null, "an error child is an error");
  const vi = parseJUnit(VITEST);
  assert(vi.length === 2 && vi[0].suites.join() === "src/math.test.ts,add", "a lone <testsuite> root with nested suites");
  assert(parseJUnit(`<testsuites><testsuite name="s"><testcase name="t"><failure>boom</failure></testcase></testsuite></testsuites>`)[0].message === "boom", "a failure message from element text");
  assert(parseJUnit("<testsuites/>").length === 0, "an empty <testsuites/> has no cases");
  const node = parseJUnit(NODE_TEST);
  assert(node.length === 3 && node[0].suites.length === 0 && node[1].status === "failed", "node:test: testcases directly under <testsuites> are read");
  assert(node[2].suites.join() === "refresh" && executedCount(node) === 3, "alongside nested suites");
  throws(() => parseJUnit("<html><body/></html>", "x.xml"), /bad_results.*no <testsuites>/, "a document that isn't JUnit is rejected");
  throws(() => parseJUnit("<testsuites><testsuite>", "y.xml"), /bad_results/, "malformed XML is rejected");

  console.log("\nSelectors\n");

  assert(parseSelector("./tests/a.test.ts::does a thing").path === "tests/a.test.ts", "a selector is path::name");
  assert(parseSelector("tests/a.test.ts").name === null, "a bare path selects the whole file");

  const r = (sel: string, cases = jest) => resolveSelector(sel, cases).executed;
  assert(r("tests/auth/refresh.test.ts::refreshes valid token") === "passed", "jest: the name matches the end of the full name");
  assert(r("tests/auth/refresh.test.ts::rejects expired token") === "failed", "a failing match is failed");
  assert(resolveSelector("tests/auth/refresh.test.ts::rejects expired token", jest).message === "expected 401 & got 500", "with its message");
  assert(r("tests/auth/refresh.test.ts::later") === "skipped", "a skipped match is skipped (a failure, §5.1)");
  assert(r("tests/auth/refresh.test.ts::no such test") === "not_found", "no match is not_found");
  assert(r("tests/other.test.ts::refreshes valid token") === "not_found", "the path must match too");
  assert(r("auth/refresh.test.ts::refreshes valid token") === "passed", "a path suffix on a segment boundary matches");
  assert(r("h/refresh.test.ts::refreshes valid token") === "not_found", "a partial segment doesn't");
  assert(r("tests/auth/refresh.test.ts::refresh*token") === "failed", "a wildcard selects several; the worst result wins");
  assert(r("tests/auth/refresh.test.ts") === "failed", "a bare path needs every test in the file to pass");
  assert(r("tests/test_auth.py::test_rejects_expired", py) === "passed", "pytest: dotted classname and name");
  assert(r("tests/test_auth.py::test_boom", py) === "error", "pytest: an error");
  assert(r("tests/test_other.py::test_boom", py) === "not_found", "pytest: another module doesn't match");
  assert(r("src/math.test.ts::adds numbers", vi) === "passed", "vitest: a test name matches the end of 'add > adds numbers'");
  assert(r("src/math.test.ts::add > adds numbers", vi) === "passed", "vitest: classname is the path");
  assert(executedCount(jest) === 3, "skipped cases don't count as executed");

  console.log("\nPlaywright\n");

  const pw = parseJUnit(PLAYWRIGHT, "playwright.xml");
  const pwSub = parseJUnit(PLAYWRIGHT_SUBDIR, "playwright.xml");
  const one = resolveSelector("e2e/graph.spec.ts::Graph › adds a node", pw);
  assert(
    one.executed === "passed" && one.cases.length === 1 && r("e2e/graph.spec.ts::adds a node", pw) === "passed",
    "playwright: a selector with the file path relative to the config's rootDir resolves to a single test by its describe › title name",
  );
  const failing = resolveSelector("e2e/graph.spec.ts::Graph › rejects a bad edge", pw);
  assert(
    failing.executed === "failed" &&
      failing.message === "expect(received).toBe(expected) // Object.is equality" &&
      r("e2e/graph.spec.ts::draws later", pw) === "skipped" &&
      r("e2e/graph.spec.ts::opens the editor", pw) === "passed",
    "playwright: a failing test fails its selector, a skipped one is skipped, and a test outside any describe matches by its title",
  );
  assert(
    pwSub[0].classname === "graph.spec.ts" &&
      r("e2e/graph.spec.ts::Graph › adds a node", pwSub) === "not_found" &&
      resolveSelector("e2e/graph.spec.ts::Graph › adds a node", pwSub, { nameOnly: true }).executed === "not_found",
    "playwright: a testDir below the config's rootDir writes a classname without the folder, so a repo-relative selector is not_found",
  );
  const retried = pw.find((c) => c.name === "settles after a retry");
  assert(
    retried !== undefined && retried.status === "passed" && retried.message === null && r("e2e/graph.spec.ts::settles after a retry", pw) === "passed",
    "playwright: a test that passed on retry is a plain pass in the XML, so the setup must keep retries at 0",
  );

  console.log("\nResults without file paths\n");

  const nameOnly = (sel: string, cases = node) => resolveSelector(sel, cases, { nameOnly: true });
  assert(r("tests/token.test.js::refreshes a valid token", node) === "not_found", "node:test: no file path, so a selector doesn't match by default");
  const n1 = nameOnly("tests/token.test.js::refreshes a valid token");
  assert(n1.executed === "passed" && n1.by_name_only, "with nameOnly it matches by name, and says so");
  assert(nameOnly("tests/token.test.js::rejects an expired token").executed === "failed", "a failure still fails");
  assert(nameOnly("tests/token.test.js::keeps the id").executed === "passed", "a nested test matches by the end of its full name");
  assert(nameOnly("tests/token.test.js").executed === "not_found", "a bare path never falls back");
  assert(nameOnly("tests/token.test.js::no such test").executed === "not_found", "an unknown name is still not_found");
  const viByName = nameOnly("src/other.test.ts::adds numbers", vi);
  assert(viByName.executed === "not_found", "cases that name another file never match by name alone");
  const pyByName = nameOnly("tests/test_other.py::test_boom", py);
  assert(pyByName.executed === "not_found", "nor do pytest's dotted classnames");
  const located = nameOnly("tests/auth/refresh.test.ts::refreshes valid token", jest);
  assert(located.executed === "passed" && !located.by_name_only, "a path match is preferred and not flagged");

  console.log("\nResults directories\n");

  const dir = tempDir();
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "b.xml"), PYTEST);
  writeFileSync(join(dir, "sub", "a.xml"), VITEST);
  writeFileSync(join(dir, "notes.txt"), "x");
  const files = resultFiles(dir);
  assert(files.length === 2 && files[0].endsWith("b.xml"), "every .xml under the directory, sorted");
  const all = readResults(files);
  assert(all.length === 4 && all[0].source.endsWith("b.xml"), "cases remember their results file");

  console.log("\nAll factory JUnit tests passed.");
}

try {
  run();
} finally {
  cleanup();
}
