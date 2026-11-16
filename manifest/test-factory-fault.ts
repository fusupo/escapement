import { existsSync } from "node:fs";
import { join } from "node:path";
import { faultPoint, parseFaultSpec, setFaultKill, FAULT_ENV, FAULT_DIR_ENV, FAULT_POINTS } from "./factory/fault.ts";
import { assert, throws, cleanup, tempDir } from "./factory/testkit.ts";

function run() {
  console.log("fault injection: armed points, counts, one-shot\n");
  const fired: string[] = [];
  setFaultKill((p) => fired.push(p));
  delete process.env[FAULT_ENV];
  delete process.env[FAULT_DIR_ENV];

  for (const p of FAULT_POINTS) faultPoint(p);
  assert(fired.length === 0, "unset: no point fires");

  const spec = parseFaultSpec(" validate.before_check@3 , pr.created ");
  assert(spec.get("validate.before_check") === 3 && spec.get("pr.created") === 1 && spec.size === 2, "parses point@N and bare points, ignoring spaces");
  throws(() => parseFaultSpec("validate.befor_check"), /unknown fault point/, "a mistyped point is rejected");
  throws(() => parseFaultSpec("pr.created@0"), /count of 1 or more/, "a zero count is rejected");

  process.env[FAULT_ENV] = "validate.before_check@2,pr.created";
  faultPoint("validate.before_check");
  assert(fired.length === 0, "@2: the first hit doesn't fire");
  faultPoint("validate.before_check");
  assert(fired.join() === "validate.before_check", "@2: the second hit fires");
  faultPoint("validate.before_check");
  assert(fired.length === 1, "@2: later hits don't fire again in the same process");
  faultPoint("record-review.verdict_stored");
  assert(fired.length === 1, "a point that isn't armed doesn't fire");

  const dir = join(tempDir(), "faults");
  process.env[FAULT_DIR_ENV] = dir;
  setFaultKill((p) => fired.push(p));
  faultPoint("pr.created");
  assert(fired.at(-1) === "pr.created" && existsSync(join(dir, "pr.created.fired")), "with a fault dir, firing leaves {point}.fired");
  setFaultKill((p) => fired.push(p)); // a new process: hit counts start afresh
  faultPoint("pr.created");
  assert(fired.filter((p) => p === "pr.created").length === 1, "with a fault dir, a point fires only once across processes");

  delete process.env[FAULT_ENV];
  delete process.env[FAULT_DIR_ENV];
  setFaultKill(null);
  cleanup();
  console.log("\nAll fault injection tests passed.");
}

try {
  run();
} catch (err) {
  console.error(err);
  cleanup();
  process.exit(1);
}
