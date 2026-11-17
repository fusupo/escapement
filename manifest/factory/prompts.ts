import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Prompts the factory ships as data (prompts/factory/*.md at the plugin
 * root), so any runtime can run the same agent: the Claude Code agent in
 * agents/ is a thin wrapper over the same file.
 */
export const PROMPT_NAMES = ["reviewer", "critic"] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

const FILES: Record<PromptName, string> = { reviewer: "validation-reviewer.md", critic: "plan-critic.md" };
const PROMPT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts", "factory");

export function promptPath(name: PromptName): string {
  return resolve(PROMPT_DIR, FILES[name]);
}

export function isPromptName(name: string): name is PromptName {
  return (PROMPT_NAMES as readonly string[]).includes(name);
}
