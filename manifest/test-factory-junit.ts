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
