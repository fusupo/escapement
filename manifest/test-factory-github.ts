import { realpathSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { agentToken, agentIdentity, gh, remoteOf, pushBranch, TOKEN_VAR, agentEnvPath, parseAgentEnv } from "./factory/github.ts";
import { assert, throws, cleanup, makeRepo, tempDir, sh, stubGh } from "./factory/testkit.ts";

const TOKEN = "ghp_test_agent_token_123";

async function run() {
  console.log("Agent token\n");
  const noFile = { XDG_CONFIG_HOME: tempDir() };
  throws(() => agentToken(noFile), /no_agent_token[\s\S]*agent\.env/, "no token: blocked, never the operator's login; the message names agent.env");
  throws(() => agentToken({ ...noFile, [TOKEN_VAR]: "  " }), /no_agent_token/, "a blank token counts as none");
  assert(agentToken({ ...noFile, [TOKEN_VAR]: ` ${TOKEN} ` }) === TOKEN, "the token comes from the environment, trimmed");

  console.log("\nagent.env\n");
  const cfg = tempDir();
  const fileEnv = { XDG_CONFIG_HOME: cfg };
  const file = agentEnvPath(fileEnv);
  assert(file === join(cfg, "escapement", "agent.env"), "the file is $XDG_CONFIG_HOME/escapement/agent.env");
  assert(agentEnvPath({ HOME: "/h" }) === "/h/.config/escapement/agent.env", "else ~/.config/escapement/agent.env");
  const parsed = parseAgentEnv(`# agent\nexport ESCAPEMENT_AGENT_GH_TOKEN="ghp_file"\nESCAPEMENT_AGENT_NAME='Escapement Agent'\nOTHER_SECRET=nope\n\nnot a line\n`);
  assert(parsed.ESCAPEMENT_AGENT_GH_TOKEN === "ghp_file" && parsed.ESCAPEMENT_AGENT_NAME === "Escapement Agent", "KEY=value lines, export and quotes allowed");
  assert(!("OTHER_SECRET" in parsed), "only the agent keys are read");
  mkdirSync(join(cfg, "escapement"), { recursive: true });
  writeFileSync(file, "ESCAPEMENT_AGENT_GH_TOKEN=ghp_from_file\nESCAPEMENT_AGENT_NAME=File Agent\nESCAPEMENT_AGENT_EMAIL=agent@example.invalid\n");
  chmodSync(file, 0o644);
  throws(() => agentToken(fileEnv), /agent_env_permissions[\s\S]*chmod 600/, "a file others can read is refused, like an ssh key");
  chmodSync(file, 0o600);
  assert(agentToken(fileEnv) === "ghp_from_file", "the token comes from the file when the environment has none");
  assert(agentToken({ ...fileEnv, [TOKEN_VAR]: "ghp_env" }) === "ghp_env", "the environment wins over the file");
  const fromFile = agentIdentity(fileEnv);
  assert(fromFile.name === "File Agent" && fromFile.email === "agent@example.invalid" && fromFile.source === "env", "name and email from the file, without asking GitHub");

  console.log("\ngh as the agent\n");
  const stub = stubGh();
  const env = { ...process.env, PATH: stub.path, GITHUB_TOKEN: "operator-token" };
  const out = gh(["pr", "list", "-R", "acme/w", "--head", "x", "--state", "open", "--json", "number"], { token: TOKEN, env });
  assert(out === "[]", "gh runs and its output is returned");
  const call = stub.calls()[0];
  assert(call.token === TOKEN && call.githubToken === null, "gh gets the agent token as GH_TOKEN; GITHUB_TOKEN is dropped");
  assert(!call.args.join(" ").includes(TOKEN), "the token is never in gh's argv");
  stub.setState({ failOn: "list" });
  throws(
    () => gh(["pr", "list", "-R", "acme/w"], { token: TOKEN, env }),
    /gh_failed(?![\s\S]*ghp_test)[\s\S]*\*\*\*/,
    "a gh failure is gh_failed, with the token redacted from its message",
  );
  stub.setState({ failOn: null });
  throws(() => gh(["api", "user"], { token: TOKEN, env: { ...process.env, PATH: tempDir() } }), /gh_missing/, "no gh on PATH: gh_missing");

  console.log("\nAgent identity\n");
  const before = stub.calls().length;
  let id = agentIdentity({ ...noFile, ESCAPEMENT_AGENT_NAME: "Bot", ESCAPEMENT_AGENT_EMAIL: "bot@example.invalid", PATH: stub.path });
  assert(id.name === "Bot" && id.email === "bot@example.invalid" && id.source === "env", "name and email from the environment");
  assert(stub.calls().length === before, "with both set, GitHub isn't asked");
  id = agentIdentity({ ...noFile, [TOKEN_VAR]: TOKEN, PATH: stub.path });
  assert(
    id.name === "agent-bot" && id.email === "4242+agent-bot@users.noreply.github.com" && id.login === "agent-bot" && id.source === "github",
    "otherwise the token's account: login and noreply address",
  );
  id = agentIdentity({ ...noFile, [TOKEN_VAR]: TOKEN, ESCAPEMENT_AGENT_NAME: "Escapement Agent", PATH: stub.path });
  assert(id.name === "Escapement Agent" && id.email.startsWith("4242+"), "a name alone overrides only the name");
  throws(() => agentIdentity({ ...noFile, PATH: stub.path }), /no_agent_token/, "no identity and no token: blocked");

  console.log("\nThe remote\n");
  const repo = realpathSync(makeRepo({ branch: "42-x", origin: "git@github.com:acme/w.git" }));
  let r = remoteOf(repo, "acme/w");
  assert(r.host === "github.com" && r.ghRepo === "acme/w", "scp-style GitHub remote");
  sh("git", ["remote", "set-url", "origin", "https://ghe.example.com/acme/w.git"], repo);
  r = remoteOf(repo, "acme/w");
  assert(r.host === "ghe.example.com" && r.ghRepo === "ghe.example.com/acme/w", "an Enterprise host is named for gh");
  sh("git", ["remote", "set-url", "origin", "ssh://git@github.com/acme/w.git"], repo);
  assert(remoteOf(repo, "acme/w").host === "github.com", "ssh:// remote");
  const bare = join(tempDir(), "origin.git");
  sh("git", ["init", "-q", "--bare", bare], tempDir());
  sh("git", ["remote", "set-url", "origin", bare], repo);
  r = remoteOf(repo, "acme/w");
  assert(r.host === null && r.ghRepo === "acme/w", "a local remote has no host");
  sh("git", ["remote", "remove", "origin"], repo);
  throws(() => remoteOf(repo, "acme/w"), /no_remote/, "no origin: no_remote");
  sh("git", ["remote", "add", "origin", bare], repo);

  console.log("\nPush\n");
  sh("git", ["checkout", "-q", "-b", "side"], repo);
  writeFileSync(join(repo, "side.txt"), "side\n");
  sh("git", ["add", "side.txt"], repo);
  sh("git", ["commit", "-q", "-m", "side"], repo);
  sh("git", ["checkout", "-q", "42-x"], repo);
  pushBranch({ worktree: repo, remote: remoteOf(repo, "acme/w"), repo: "acme/w", branch: "42-x", token: TOKEN });
  const heads = sh("git", ["for-each-ref", "--format=%(refname)", "refs/heads"], bare);
  assert(heads === "refs/heads/42-x", "only the run's branch is pushed");
  assert(sh("git", ["rev-parse", "refs/heads/42-x"], bare) === sh("git", ["rev-parse", "HEAD"], repo), "the branch gets HEAD");

  // A rewritten history needs a force push, which the authorization excludes.
  sh("git", ["commit", "-q", "--amend", "-m", "rewritten"], repo);
  throws(
    () => pushBranch({ worktree: repo, remote: remoteOf(repo, "acme/w"), repo: "acme/w", branch: "42-x", token: TOKEN }),
    /push_failed/,
    "a push that would need --force is refused",
  );

  // On a GitHub remote the push goes to https://github.com/{repo}.git,
  // whatever origin's protocol; insteadOf points that URL at a local bare repo.
  const gbare = join(tempDir(), "gh.git");
  sh("git", ["init", "-q", "--bare", gbare], tempDir());
  sh("git", ["remote", "set-url", "origin", "git@github.com:acme/w.git"], repo);
  sh("git", ["config", `url.${gbare}.insteadOf`, "https://github.com/acme/w.git"], repo);
  pushBranch({ worktree: repo, remote: remoteOf(repo, "acme/w"), repo: "acme/w", branch: "42-x", token: TOKEN });
  assert(sh("git", ["rev-parse", "refs/heads/42-x"], gbare) === sh("git", ["rev-parse", "HEAD"], repo), "a GitHub remote is pushed over https as the agent");

  cleanup();
  console.log("\nAll GitHub access tests passed.");
}

run().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
