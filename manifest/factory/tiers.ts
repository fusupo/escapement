import type { FactorySettings } from "./settings.ts";
import { firstMatch } from "./glob.ts";

/**
 * Risk tiers (docs/FACTORY_DESIGN.md §3.3). In the first release the tier
 * changes gate eligibility and review emphasis, not the validation phases.
 */
export const TIERS = ["standard", "sensitive"] as const;
export type Tier = (typeof TIERS)[number];

export type TierAssessment = { tier: Tier; reasons: string[] };

/**
 * Assess the tier of a set of changed (or predicted) files.
 *
 * - A file matching `sensitive-paths` makes the run sensitive.
 * - A file matching `validation-files` is an execution-policy change (§4.6)
 *   and also makes it sensitive.
 * - A `proposed` tier, with its own reasons (e.g. the planner judged the
 *   work to touch auth or a public API), is kept: the higher tier wins, and
 *   the tier never goes down.
 *
 * The same function serves planning (contract `predicted_files`) and
 * validation (the actual `merge_base..head` diff, #61).
 */
export function assessTier(opts: {
  files: readonly string[];
  settings: Pick<FactorySettings, "sensitivePaths" | "validationFiles">;
  proposed?: Tier;
  reasons?: readonly string[];
}): TierAssessment {
  const reasons = [...(opts.reasons ?? [])];
  let sensitive = opts.proposed === "sensitive";
  for (const file of opts.files) {
    const sensitivePath = firstMatch(file, opts.settings.sensitivePaths);
    if (sensitivePath) {
      sensitive = true;
      reasons.push(`sensitive path: ${file} (matches ${sensitivePath})`);
    }
    const policy = firstMatch(file, opts.settings.validationFiles);
    if (policy) {
      sensitive = true;
      reasons.push(`execution policy: ${file} (matches ${policy})`);
    }
  }
  if (sensitive && reasons.length === 0) reasons.push("proposed as sensitive");
  return { tier: sensitive ? "sensitive" : "standard", reasons };
}
