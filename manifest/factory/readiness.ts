import { schemaErrors, contractErrors, type Contract } from "./schemas.ts";
import { readSettings, type CheckName } from "./settings.ts";
import { assessTier, type TierAssessment } from "./tiers.ts";
import { defaultTargetRef } from "./context.ts";

/**
 * The mechanical half of the readiness check (docs/FACTORY_DESIGN.md §3.1).
 *
 * `factory check` answers "can this contract run in this project?": the
 * contract is valid, every criterion has evidence, and the settings it
 * depends on are configured. Whether the criteria capture the intent, and
 * whether scope and dependencies are clear, is the planner's judgment; a
 * planning agent adds those questions in the same shape (readiness.schema.json).
 */

export type ReadinessQuestion = {
  about: "contract" | "criterion" | "evidence" | "settings" | "intent" | "scope" | "dependency";
  question: string;
  ref?: string;
};

export type Readiness = {
  version: 1;
  status: "ready" | "needs_human";
  questions: ReadinessQuestion[];
  tier?: TierAssessment;
  required_checks: { name: CheckName; command: string | null }[];
  /** The branch `factory start` targets without --target-ref: base-branch, else develop when origin/develop exists, else main. */
  target_ref: string;
  settings_digest: string;
};

type CriterionLike = { id?: unknown };

function criterionRef(data: unknown, index: number): string {
  const c = (data as { criteria?: CriterionLike[] })?.criteria?.[index];
  return typeof c?.id === "string" ? c.id : `/criteria/${index}`;
}

/** Turn a contract error into a question a human can act on. */
function contractQuestion(error: string, data: unknown): ReadinessQuestion {
  if (/^\/criteria: must NOT have fewer than 1 items/.test(error) || /^\(top level\): missing "criteria"/.test(error)) {
    return { about: "criterion", question: "The contract has no acceptance criteria. What must this work demonstrate?" };
  }
  const empty = error.match(/^\/criteria\/(\d+)(?:\/evidence: must NOT have fewer than 1 items|: missing "evidence")/);
  if (empty) {
    const ref = criterionRef(data, Number(empty[1]));
    return {
      about: "criterion",
      ref,
      question: `Criterion ${ref} has no evidence. What test, command or manual check would show it is met?`,
    };
  }
  const at = error.match(/^(\S+): /);
  return {
    about: "contract",
    ...(at && at[1] !== "(top level)" ? { ref: at[1] } : {}),
    question: `The contract is invalid: ${error}. How should it be corrected?`,
  };
}

/**
 * Check a contract against the project in `projectDir` (its CLAUDE.md
 * settings). `contractText` is the file's content, or null if unreadable.
 * Without a contract (`undefined`), only the settings are checked: a host
 * can ask whether the project is set up for the factory before planning.
 */
export function checkReadiness(opts: { contractText?: string | null; source: string; projectDir: string }): Readiness {
  const questions: ReadinessQuestion[] = [];
  const loaded = readSettings(opts.projectDir);
  const { settings } = loaded;

  let data: unknown = undefined;
  if (opts.contractText === undefined) {
    // settings only
  } else if (opts.contractText === null) {
    questions.push({ about: "contract", question: `Cannot read ${opts.source}. Where is the contract?` });
  } else {
    try {
      data = JSON.parse(opts.contractText);
    } catch (err) {
      questions.push({ about: "contract", question: `${opts.source} is not valid JSON (${(err as Error).message}). How should it be corrected?` });
    }
  }

  let contract: Contract | null = null;
  if (data !== undefined) {
    const errors = contractErrors(data);
    for (const e of errors) questions.push(contractQuestion(e, data));
    if (errors.length === 0) contract = data as Contract;
  }

  for (const e of loaded.errors) {
    questions.push({ about: "settings", ref: e.key, question: `Escapement Settings ${e.key}: ${e.message}. What should it be?` });
  }

  const required_checks = settings.requiredChecks.map((name) => ({ name, command: settings[name] }));
  for (const check of required_checks) {
    if (check.command === null) {
      questions.push({
        about: "settings",
        ref: check.name,
        question: `"${check.name}" is a required check, but the project sets no ${check.name} command in Escapement Settings. What command runs it?`,
      });
    }
  }

  if (contract) {
    const tests = contract.criteria.flatMap((c) => c.evidence).filter((e) => e.type === "test");
    if (tests.length > 0 && settings.testResults === null && !loaded.errors.some((e) => e.key === "test-results")) {
      questions.push({
        about: "settings",
        ref: "test-results",
        question: `The contract has test evidence (${tests.map((e) => e.id).join(", ")}), which is read from structured test results, but the project sets no test-results. Where does verify write JUnit XML?`,
      });
    }
  }

  const readiness: Readiness = {
    version: 1,
    status: questions.length === 0 ? "ready" : "needs_human",
    questions,
    ...(contract
      ? {
          tier: assessTier({
            files: contract.predicted_files ?? [],
            settings,
            proposed: contract.risk_tier_proposed,
            reasons: contract.risk_reasons,
          }),
        }
      : {}),
    required_checks,
    target_ref: settings.baseBranch ?? defaultTargetRef(opts.projectDir),
    settings_digest: loaded.digest,
  };

  // The output is a published document; keep it honest.
  const errors = schemaErrors("readiness", readiness);
  if (errors.length > 0) throw new Error(`internal: readiness output fails its schema: ${errors.join("; ")}`);
  return readiness;
}
