import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { git } from "./context.ts";
import { FactoryError, blocked } from "./util.ts";

/**
 * GitHub access for the authorized path (§3.6, §4.8). Everything the factory
 * does on GitHub (push the run's branch, find, create and edit its PR, read
 * the PR's state) runs as the AI agent's GitHub identity, so its work is
 * visible as the agent's and not the operator's:
 *
 * - `ESCAPEMENT_AGENT_GH_TOKEN` (required): the agent account's token. It
 *   reaches `gh` as GH_TOKEN and `git push` through a credential helper
 *   that reads the variable, so it never appears in argv, URLs, logs,
 *   events or JSON output. Without it the runner refuses (`no_agent_token`)
 *   and never falls back to the operator's own login.
 * - `ESCAPEMENT_AGENT_NAME` / `ESCAPEMENT_AGENT_EMAIL` (optional): commit
 *   author for the agent's commits. Default: the token account's login and
 *   its GitHub noreply address, so GitHub links the commits to the account.
 *
 * Each variable comes from the environment, or else from the user's
 * `${XDG_CONFIG_HOME:-~/.config}/escapement/agent.env` (`KEY=value` lines;
 * only these three keys are read). The identity belongs to the user, not a
 * project, so it never comes from a project file. Like an ssh key, the file
 * is refused (`agent_env_permissions`) when group or others can read it.
 *
 * The runner calls the `gh` CLI (found on PATH) and never a skill or an agent.
 */

export const TOKEN_VAR = "ESCAPEMENT_AGENT_GH_TOKEN";
export const NAME_VAR = "ESCAPEMENT_AGENT_NAME";
export const EMAIL_VAR = "ESCAPEMENT_AGENT_EMAIL";

const AGENT_KEYS = [TOKEN_VAR, NAME_VAR, EMAIL_VAR] as const;

/** `${XDG_CONFIG_HOME:-~/.config}/escapement/agent.env`. */
export function agentEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "escapement", "agent.env");
}

/** Parse `KEY=value` lines (an optional `export `, matching quotes stripped, `#` comments); only the agent keys. */
export function parseAgentEnv(text: string): Partial<Record<(typeof AGENT_KEYS)[number], string>> {
  const out: Partial<Record<(typeof AGENT_KEYS)[number], string>> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || !(AGENT_KEYS as readonly string[]).includes(m[1])) continue;
    let value = m[2].trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) value = value.slice(1, -1);
    out[m[1] as (typeof AGENT_KEYS)[number]] = value;
  }
  return out;
}

/**
 * The environment with each agent variable that isn't set filled in from
 * agent.env. A variable set in the environment always wins. The file is
 * read only when a variable is missing.
 */
export function withAgentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (AGENT_KEYS.every((k) => env[k]?.trim())) return env;
  const path = agentEnvPath(env);
  if (!existsSync(path)) return env;
  if ((statSync(path).mode & 0o077) !== 0) {
    throw blocked("agent_env_permissions", `${path} can be read by other users; run: chmod 600 ${path}`);
  }
  const fromFile = parseAgentEnv(readFileSync(path, "utf-8"));
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const k of AGENT_KEYS) {
    if (!merged[k]?.trim() && fromFile[k]) merged[k] = fromFile[k];
  }
  return merged;
}

export function agentToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = withAgentEnv(env)[TOKEN_VAR]?.trim();
  if (!token) {
    throw blocked(
      "no_agent_token",
      `${TOKEN_VAR} is not set; the factory acts on GitHub only as the agent's identity (export it, or put it in ${agentEnvPath(env)})`,
    );
  }
  return token;
}

function redact(text: string, token: string): string {
  return token ? text.split(token).join("***") : text;
}

/**
 * Run `gh` as the agent. Prompts and update checks are off; a failure is
 * `gh_failed` with gh's stderr (token redacted).
 */
export function gh(args: string[], opts: { token: string; cwd?: string; env?: NodeJS.ProcessEnv }): string {
  const env = {
    ...(opts.env ?? process.env),
    GH_TOKEN: opts.token,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
  };
  delete (env as Record<string, string | undefined>).GITHUB_TOKEN;
  try {
    return execFileSync("gh", args, { cwd: opts.cwd, env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message?: string };
    if (e.code === "ENOENT") throw new FactoryError("gh_missing", "the gh CLI is not installed (https://cli.github.com)");
    const why = redact((e.stderr ?? e.message ?? "").trim(), opts.token);
    throw new FactoryError("gh_failed", `gh ${args.slice(0, 2).join(" ")} failed${why ? `: ${why}` : ""}`);
  }
}

export function ghJson<T>(args: string[], opts: { token: string; cwd?: string; env?: NodeJS.ProcessEnv }): T {
  const out = gh(args, opts);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new FactoryError("gh_failed", `gh ${args.slice(0, 2).join(" ")} returned no JSON`);
  }
}

export type AgentIdentity = { name: string; email: string; login: string | null; source: "env" | "github" };

/** The commit author for the agent's commits. */
export function agentIdentity(env0: NodeJS.ProcessEnv = process.env): AgentIdentity {
  const env = withAgentEnv(env0);
  const name = env[NAME_VAR]?.trim();
  const email = env[EMAIL_VAR]?.trim();
  if (name && email) return { name, email, login: null, source: "env" };
  const token = agentToken(env);
  const user = ghJson<{ login?: string; id?: number }>(["api", "user"], { token, env });
  if (!user.login || typeof user.id !== "number") throw new FactoryError("gh_failed", "gh api user returned no login");
  return {
    name: name || user.login,
    email: email || `${user.id}+${user.login}@users.noreply.github.com`,
    login: user.login,
    source: "github",
  };
}

// ── the remote ───────────────────────────────────────────────────────

export type Remote = {
  /** origin's URL as configured. */
  url: string;
  /** GitHub host (github.com or an Enterprise host); null for a local remote. */
  host: string | null;
  /** `-R` value for gh: `owner/repo`, or `host/owner/repo` off github.com. */
  ghRepo: string;
};

/** Where `origin` points. A local path or file:// remote has no host (tests, mirrors). */
export function remoteOf(worktree: string, repo: string): Remote {
  let url: string;
  try {
    url = git(["config", "--get", "remote.origin.url"], worktree);
  } catch {
    throw new FactoryError("no_remote", `the repository at ${worktree} has no origin remote`);
  }
  const scp = url.match(/^[\w.-]+@([^:/]+):/);
  const web = url.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)/);
  const host = scp?.[1] ?? web?.[1] ?? null;
  return { url, host, ghRepo: !host || host === "github.com" ? repo : `${host}/${repo}` };
}

/**
 * Push HEAD to `refs/heads/{branch}` and nothing else, never forced (the
 * authorization excludes force_push and push_other_branches). On a GitHub
 * remote the push goes to `https://{host}/{repo}.git` with the agent token
 * from a credential helper that reads the environment variable, whatever
 * protocol origin uses, so it is the agent that pushes. A local remote is
 * pushed to as configured.
 */
export function pushBranch(opts: { worktree: string; remote: Remote; repo: string; branch: string; token: string }): void {
  const refspec = `HEAD:refs/heads/${opts.branch}`;
  const env = { ...process.env, [TOKEN_VAR]: opts.token, GIT_TERMINAL_PROMPT: "0" };
  const args = opts.remote.host
    ? [
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=!f() { echo username=x-access-token; echo "password=$${TOKEN_VAR}"; }; f`,
        "push",
        `https://${opts.remote.host}/${opts.repo}.git`,
        refspec,
      ]
    : ["push", "origin", refspec];
  try {
    execFileSync("git", args, { cwd: opts.worktree, env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const why = redact(((err as { stderr?: string }).stderr ?? "").trim(), opts.token);
    throw new FactoryError("push_failed", `git push of ${opts.branch} failed${why ? `: ${why}` : ""}`);
  }
}
