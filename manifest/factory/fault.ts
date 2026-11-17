import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Fault injection for acceptance tests (#65), for testing only. It does
 * nothing unless `ESCAPEMENT_FACTORY_FAULT` is set.
 *
 * `ESCAPEMENT_FACTORY_FAULT` is a comma-separated list of points, each
 * `point` or `point@N` (fire on the Nth time the point is reached in this
 * process; default 1). When a point fires, the runner writes one line to
 * stderr and SIGKILLs itself: no `finally`, no lock release, no JSON, exit
 * status 137, exactly what a crash leaves behind.
 *
 * With `ESCAPEMENT_FACTORY_FAULT_DIR` set, each point fires at most once
 * across processes: firing leaves `{dir}/{point}.fired`, and a point whose
 * file exists is skipped. That lets one real run arm several points and
 * still resume past each of them.
 *
 * The points are listed in FAULT_POINTS and docs/FACTORY_CLI.md.
 */

export const FAULT_ENV = "ESCAPEMENT_FACTORY_FAULT";
export const FAULT_DIR_ENV = "ESCAPEMENT_FACTORY_FAULT_DIR";

export const FAULT_POINTS = [
  /** validate: the attempt is checks_running and the next check is about to start. */
  "validate.before_check",
  /** validate: the attempt's report.json is written, the attempt is still checks_running. */
  "validate.report_written",
  /** validate: the attempt is awaiting_review (or complete), before the result is printed. */
  "validate.committed",
  /** review-input: the bundle is written and the review recorded as issued. */
  "review-input.issued",
  /** record-review: review.json is stored and the attempt is finalizing. */
  "record-review.verdict_stored",
  /** record-review: the final report.json is written, the attempt is still finalizing. */
  "record-review.report_written",
  /** record-review: the attempt is complete and the run has moved on (validated, back to implementing, or escalated), before the result is printed. */
  "record-review.committed",
  /** continue: the run is back in implementing, before the result is printed. */
  "continue.committed",
  /** pr: `gh pr create` succeeded, the PR number is not yet recorded. */
  "pr.created",
  /** pr: the PR number is recorded, before the result is printed. */
  "pr.recorded",
] as const;

export type FaultPoint = (typeof FAULT_POINTS)[number];

export type FaultSpec = Map<string, number>;

/** Parse `point[@N],…`. Unknown points and bad counts are rejected, so a typo can't silently arm nothing. */
export function parseFaultSpec(value: string): FaultSpec {
  const spec: FaultSpec = new Map();
  for (const raw of value.split(",")) {
    const item = raw.trim();
    if (!item) continue;
    const m = item.match(/^([a-z-]+\.[a-z_]+)(?:@(\d+))?$/);
    if (!m || !(FAULT_POINTS as readonly string[]).includes(m[1])) {
      throw new Error(`${FAULT_ENV}: unknown fault point "${item}" (known: ${FAULT_POINTS.join(", ")})`);
    }
    const n = m[2] === undefined ? 1 : Number(m[2]);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${FAULT_ENV}: "${item}" needs a count of 1 or more`);
    spec.set(m[1], n);
  }
  return spec;
}

const hits = new Map<string, number>();
let kill: (point: string) => void = () => {
  process.kill(process.pid, "SIGKILL");
};

/** Tests only: observe a fired point instead of dying, and start counting afresh. */
export function setFaultKill(fn: ((point: string) => void) | null): void {
  kill = fn ?? (() => process.kill(process.pid, "SIGKILL"));
  hits.clear();
}

/** Crash here if `point` is armed (see the module comment). */
export function faultPoint(point: FaultPoint): void {
  const value = process.env[FAULT_ENV];
  if (!value) return;
  const want = parseFaultSpec(value).get(point);
  if (want === undefined) return;
  const n = (hits.get(point) ?? 0) + 1;
  hits.set(point, n);
  if (n !== want) return;
  const dir = process.env[FAULT_DIR_ENV];
  if (dir) {
    const fired = join(dir, `${point}.fired`);
    if (existsSync(fired)) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(fired, `${new Date().toISOString()} pid ${process.pid}\n`);
  }
  process.stderr.write(`factory: fault injected at ${point} (${FAULT_ENV})\n`);
  kill(point);
}
