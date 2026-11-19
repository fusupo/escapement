import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { git, currentBranch, defaultTargetRef, mainRepoRoot, repoName } from "./context.ts";
import { readSettings } from "./settings.ts";
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
 * Skills outside a run use the same identity: `factory agent` gives plain
 * commit-changes its commit author, and `factory push` (pushAsAgent) pushes
 * a plain branch with the agent token. Skills reach GitHub otherwise only
 * through the GitHub MCP tools, which act as the agent too.
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
 * `gh_failed` with gh's stderr (token redacted). gh is pinned to github.com
 * (GH_HOST), whatever host the caller's environment or gh's own config
 * names, and no Enterprise token rides along (#87): the agent token is a
 * github.com credential. Callers with an origin check its host first
 * (assertTokenHost / assertPushTarget).
 */
export function gh(args: string[], opts: { token: string; cwd?: string; env?: NodeJS.ProcessEnv }): string {
  const env = {
    ...(opts.env ?? process.env),
    GH_TOKEN: opts.token,
    GH_HOST: GITHUB_HOST,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
  };
  for (const k of ["GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete (env as Record<string, string | undefined>)[k];
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

/**
 * The host a git URL reaches, the way git reads it (#87), or null for a
 * local one:
 * - a URL with a scheme (`https://`, `ssh://`, `git://`, …) has the host of
 *   its authority, without user or port; `file://` is local when its host
 *   is empty or `localhost`;
 * - a string with no scheme and a `:` before the first `/` is scp-style,
 *   `[user@]host:path`, and has that host whether or not a user is given
 *   (a remote helper's `transport::address` reads as host `transport`, so
 *   it is never taken for local);
 * - anything else is a local path.
 */
export function urlHost(url: string): string | null {
  const scheme = url.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)/);
  if (scheme) {
    const authority = scheme[2].replace(/^[^@]*@/, "");
    const host = (authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.replace(/:\d*$/, "")).toLowerCase();
    if (scheme[1].toLowerCase() === "file") return host === "" || host === "localhost" ? null : host;
    return host || null;
  }
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  if (colon > 0 && (slash === -1 || colon < slash)) {
    const host = url.slice(0, colon).replace(/^[^@]*@/, "").toLowerCase();
    return host || null;
  }
  return null;
}

/** The URL without its userinfo, so a `user:password@` never reaches a message or a report. */
export function redactUrl(url: string): string {
  return url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@/]*@/, "$1");
}

/** Where `origin` points. A local path or file:// remote has no host (tests, mirrors). */
export function remoteOf(worktree: string, repo: string): Remote {
  let url: string;
  try {
    url = git(["config", "--get", "remote.origin.url"], worktree);
  } catch {
    throw new FactoryError("no_remote", `the repository at ${worktree} has no origin remote`);
  }
  const host = urlHost(url);
  return { url, host, ghRepo: !host || host === "github.com" ? repo : `${host}/${repo}` };
}

/** The only host the agent token is ever sent to. */
export const GITHUB_HOST = "github.com";

/**
 * The agent token is a github.com credential: a remote on any other host
 * (GitLab, a self-hosted server, GitHub Enterprise) is refused before the
 * token is used (`not_github`, #80). A local remote has no host and never
 * gets the token. The refusal's detail says the cause is origin's host.
 */
export function assertTokenHost(remote: Remote): void {
  if (remote.host && remote.host !== GITHUB_HOST) {
    throw blocked(
      "not_github",
      `origin is on ${remote.host}, not ${GITHUB_HOST}; the agent token is only ever sent to ${GITHUB_HOST}`,
      { cause: "origin_host", host: remote.host },
    );
  }
}

/**
 * The URL git pushes to when told to push to `url` (#87). git rewrites a
 * URL with the longest `url.<base>.insteadOf` prefix that matches it, and a
 * push URL with the longest `url.<base>.pushInsteadOf` instead when one
 * matches (the original URL, not the insteadOf result); each applies once.
 * Every config scope counts, as it does for the push, so this reads the
 * config in the worktree. A remote's `pushurl` gets insteadOf only, never
 * pushInsteadOf, as in git: `opts.pushInsteadOf: false` resolves one so
 * (#120, `namedRemoteUrls`).
 */
export function resolvePushUrl(worktree: string, url: string, opts: { pushInsteadOf?: boolean } = {}): string {
  let raw = "";
  try {
    raw = execFileSync("git", ["config", "-z", "--get-regexp", "^url\\..*\\.(push)?insteadof$"], {
      cwd: worktree,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return url; // exit 1: no rewrite configured
  }
  const best = { insteadof: null as { base: string; prefix: string } | null, pushinsteadof: null as { base: string; prefix: string } | null };
  for (const entry of raw.split("\0")) {
    const nl = entry.indexOf("\n");
    if (nl === -1) continue;
    const key = entry.slice(0, nl);
    const prefix = entry.slice(nl + 1);
    const m = key.match(/^url\.(.*)\.(pushinsteadof|insteadof)$/i);
    if (!m || !prefix || !url.startsWith(prefix)) continue;
    const kind = m[2].toLowerCase() as "insteadof" | "pushinsteadof";
    const current = best[kind];
    if (!current || prefix.length > current.prefix.length) best[kind] = { base: m[1], prefix };
  }
  const rule = (opts.pushInsteadOf === false ? null : best.pushinsteadof) ?? best.insteadof;
  return rule ? rule.base + url.slice(rule.prefix.length) : url;
}

/**
 * Where git really pushes when told to push to `url` and a remote is named
 * after that URL (#120): `git push https://github.com/acme/w.git` uses
 * `remote."https://github.com/acme/w.git".pushurl`, else its `.url`, from
 * any config scope (repo, global, system, `-c`), which `git remote get-url`
 * doesn't see outside the repo's own config. Each pushurl is resolved with
 * insteadOf only, each url with pushInsteadOf else insteadOf, as git does.
 * Empty when no such remote is configured: git then pushes to `url`
 * itself, resolved by `resolvePushUrl`.
 */
export function namedRemoteUrls(worktree: string, url: string): string[] {
  const all = (key: string) => {
    try {
      return execFileSync("git", ["config", "--get-all", key], { cwd: worktree, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
        .split("\n")
        .filter(Boolean);
    } catch {
      return []; // exit 1: not set
    }
  };
  const pushurls = all(`remote.${url}.pushurl`);
  if (pushurls.length) return pushurls.map((u) => resolvePushUrl(worktree, u, { pushInsteadOf: false }));
  return all(`remote.${url}.url`).map((u) => resolvePushUrl(worktree, u));
}

/** `https://github.com/…`, the one place the agent's credential helper answers. */
function isGitHubHttps(url: string): boolean {
  const authority = url.match(/^https:\/\/(?:[^@/]*@)?([^/]*)\//i)?.[1];
  return authority?.toLowerCase() === GITHUB_HOST;
}

/**
 * Before a push with the agent token, check where git will really send it
 * (#87). origin's host comes first (`assertTokenHost`, cause `origin_host`).
 * Then the push URL, resolved as git will:
 * - origin on github.com is pushed at `https://github.com/{repo}.git`; after
 *   insteadOf / pushInsteadOf it must still be `https://github.com/…`, or a
 *   local path (a mirror or a test's bare repo, which no credential reaches).
 *   When a remote is named after that URL, in any config scope, git pushes
 *   to its pushurls (else its urls) instead, and each of those must pass the
 *   same test (`namedRemoteUrls`, #120);
 * - a local origin is pushed by name, so its pushurl, pushInsteadOf and
 *   insteadOf all apply (`git remote get-url --push --all origin`), and
 *   every URL it pushes to must stay local: that push carries no token, and
 *   would otherwise go out as whoever's credentials the other host takes.
 * Anything else, an ssh rewrite included, is `not_github` with cause
 * `push_url` and the resolved URL (without userinfo). Nothing is pushed.
 */
export function assertPushTarget(worktree: string, remote: Remote, repo: string): void {
  assertTokenHost(remote);
  let resolved: string;
  if (remote.host) {
    const url = `https://${remote.host}/${repo}.git`;
    resolved = resolvePushUrl(worktree, url);
    if (isGitHubHttps(resolved) || urlHost(resolved) === null) {
      const away = namedRemoteUrls(worktree, url).find((u) => !isGitHubHttps(u) && urlHost(u) !== null);
      if (away === undefined) return;
      resolved = away;
    }
  } else {
    // `git push origin` pushes to every push URL (each pushurl, else each
    // url), so every one must stay local, not just the first.
    const urls = git(["remote", "get-url", "--push", "--all", "origin"], worktree).split("\n").filter(Boolean);
    const away = urls.find((u) => urlHost(u) !== null);
    if (away === undefined) return;
    resolved = away;
  }
  const shown = redactUrl(resolved);
  throw blocked(
    "not_github",
    `the push URL resolves to ${shown}, not https://${GITHUB_HOST}: git's insteadOf, pushInsteadOf or pushurl, or a remote named after the push URL, rewrites it; the agent token is only ever sent to https://${GITHUB_HOST}, and nothing is pushed elsewhere`,
    { cause: "push_url", resolved_url: shown },
  );
}

/**
 * The `-c` arguments that give git the agent token, for `https://github.com`
 * only (#87). The empty values first clear every helper configured before
 * (the operator's own, generic or for github.com), so the helper that
 * remains reads the token from the environment and answers no other host:
 * a URL that git rewrites to another host (insteadOf, pushInsteadOf) gets
 * no token from it.
 */
export function tokenHelperArgs(): string[] {
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.https://${GITHUB_HOST}.helper=`,
    "-c",
    `credential.https://${GITHUB_HOST}.helper=!f() { echo username=x-access-token; echo "password=$${TOKEN_VAR}"; }; f`,
  ];
}

/**
 * Push HEAD to `refs/heads/{branch}` and nothing else, never forced (the
 * authorization excludes force_push and push_other_branches). On github.com
 * the push goes to `https://github.com/{repo}.git` with the agent token
 * from a credential helper that reads the environment variable, whatever
 * protocol origin uses, so it is the agent that pushes. Any other host, and
 * a push URL that git would rewrite away from github.com, is refused first
 * (`not_github`, assertPushTarget). A local remote is pushed to as
 * configured, and only while its push URL stays local.
 */
export function pushBranch(opts: { worktree: string; remote: Remote; repo: string; branch: string; token: string }): void {
  assertPushTarget(opts.worktree, opts.remote, opts.repo);
  const refspec = `HEAD:refs/heads/${opts.branch}`;
  const env = { ...process.env, [TOKEN_VAR]: opts.token, GIT_TERMINAL_PROMPT: "0" };
  const args = opts.remote.host
    ? [...tokenHelperArgs(), "push", `https://${opts.remote.host}/${opts.repo}.git`, refspec]
    : ["push", "origin", refspec];
  try {
    execFileSync("git", args, { cwd: opts.worktree, env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const why = redact(((err as { stderr?: string }).stderr ?? "").trim(), opts.token);
    throw new FactoryError("push_failed", `git push of ${opts.branch} failed${why ? `: ${why}` : ""}`);
  }
}

export type PushResult = { branch: string; sha: string; repo: string; remote: string };

/**
 * `factory push`: push the worktree's current branch as the agent, with no
 * run (§4.8). Plain skills (create-pr outside an authorized run) push this
 * way instead of `git push`, which would carry the operator's credentials.
 * The rules are the authorized push's: HEAD goes to the branch of the same
 * name and nothing else, never forced. A detached HEAD and the project's
 * base branch (the base-branch setting, else develop or main), origin's
 * default branch, `main` and `master` are refused (`push_base_branch`):
 * work reaches those through a PR. A remote off github.com is `not_github`
 * and without the agent token it is `no_agent_token`; either way nothing is
 * pushed and the caller decides whether to fall back to the operator. After
 * the push the branch tracks origin's.
 */
export function pushAsAgent(opts: { worktree: string; env?: NodeJS.ProcessEnv }): PushResult {
  const w = opts.worktree;
  const branch = currentBranch(w);
  const protectedBranches = new Set([
    (readSettings(w).settings.baseBranch ?? defaultTargetRef(w)).replace(/^origin\//, ""),
    "main",
    "master",
  ]);
  const originHead = originDefaultBranch(w);
  if (originHead) protectedBranches.add(originHead);
  if (protectedBranches.has(branch)) {
    throw blocked("push_base_branch", `${branch} is a base branch; factory push pushes feature branches only (work reaches ${branch} through a PR)`);
  }
  const repo = repoName(mainRepoRoot(w));
  const remote = remoteOf(w, repo);
  // Before the token is read: off github.com, or with a push URL rewritten
  // away from it, the caller's fallback must not depend on whether a token
  // happens to be configured.
  assertPushTarget(w, remote, repo);
  const token = agentToken(opts.env);
  const sha = git(["rev-parse", "HEAD"], w);
  pushBranch({ worktree: w, remote, repo, branch, token });
  // A push to a URL updates no remote-tracking ref. Record the branch as
  // origin's and make it the upstream, so "unpushed commits" and "is the
  // branch pushed" read true afterwards.
  git(["update-ref", `refs/remotes/origin/${branch}`, sha], w);
  git(["config", `branch.${branch}.remote`, "origin"], w);
  git(["config", `branch.${branch}.merge`, `refs/heads/${branch}`], w);
  return { branch, sha, repo, remote: remote.host ? `https://${remote.host}/${repo}.git` : remote.url };
}

/** origin's default branch, from `refs/remotes/origin/HEAD`, when it is known locally. */
function originDefaultBranch(worktree: string): string | null {
  try {
    return git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], worktree).replace(/^origin\//, "") || null;
  } catch {
    return null;
  }
}
