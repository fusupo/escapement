import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentToken,
  agentIdentity,
  gh,
  remoteOf,
  pushBranch,
  pushAsAgent,
  tokenHelperArgs,
  resolvePushUrl,
  urlHost,
  redactUrl,
  TOKEN_VAR,
  agentEnvPath,
  parseAgentEnv,
} from "./factory/github.ts";
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

  console.log("\nThe credential helper (#87)\n");
  {
    // A throwaway HOME and no system config, so only the runner's arguments
    // can answer; no terminal prompt, so a host nobody answers for fails.
    const credHome = tempDir();
    const credEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: credHome,
      XDG_CONFIG_HOME: credHome,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      [TOKEN_VAR]: TOKEN,
    };
    delete credEnv.GIT_ASKPASS;
    delete credEnv.SSH_ASKPASS;
    const fill = (host: string): string => {
      try {
        return execFileSync("git", [...tokenHelperArgs(), "credential", "fill"], {
          cwd: credHome,
          env: credEnv,
          input: `protocol=https\nhost=${host}\n\n`,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        return String((err as { stdout?: string }).stdout ?? "");
      }
    };
    const forGitHub = fill("github.com");
    const forOther = fill("elsewhere.invalid");
    assert(
      forGitHub.includes(`password=${TOKEN}`) && !forOther.includes(TOKEN) && !forOther.includes("password="),
      "the credential helper answers for https://github.com and for no other host",
    );
  }

  console.log("\nThe push URL, resolved as git will (#87)\n");
  {
    // An ssh "server" that is a local bare repo: git runs GIT_SSH_COMMAND
    // with the host and `git-receive-pack '<path>'`, and the stub runs that
    // last argument here. So a push that leaves github.com lands in `away`
    // instead of the network (the .invalid host can't resolve anyway), and
    // "nothing reaches the rewritten host" can be checked.
    const stubDir = tempDir();
    const sshStub = join(stubDir, "ssh");
    writeFileSync(sshStub, '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n');
    chmodSync(sshStub, 0o755);
    const saved = { cmd: process.env.GIT_SSH_COMMAND, variant: process.env.GIT_SSH_VARIANT };
    process.env.GIT_SSH_COMMAND = sshStub;
    process.env.GIT_SSH_VARIANT = "simple";
    const newBare = (): string => {
      const b = join(tempDir(), "away.git");
      sh("git", ["init", "-q", "--bare", b], tempDir());
      return b;
    };
    const refs = (bare: string) => sh("git", ["for-each-ref"], bare);
    const codeOf = (fn: () => unknown): { code: string; detail?: Record<string, unknown>; message: string } => {
      try {
        fn();
        return { code: "ok", message: "" };
      } catch (err) {
        const e = err as { code?: string; detail?: Record<string, unknown>; message?: string };
        return { code: e.code ?? "thrown", detail: e.detail, message: String(e.message ?? err) };
      }
    };
    const settings = "## Escapement Settings\n\n- **base-branch**: develop\n";
    const ghRepo = (branch: string) => realpathSync(makeRepo({ branch, origin: "git@github.com:acme/w.git", claudeMd: settings }));
    const runPush = (w: string, branch: string) => () =>
      pushBranch({ worktree: w, remote: remoteOf(w, "acme/w"), repo: "acme/w", branch, token: TOKEN });
    const agentEnv = { XDG_CONFIG_HOME: tempDir(), [TOKEN_VAR]: TOKEN };

    try {
      {
        const w = ghRepo("87-a");
        const away = newBare();
        sh("git", ["config", `url.ssh://elsewhere.invalid${away}.insteadOf`, "https://github.com/acme/w.git"], w);
        const r = codeOf(runPush(w, "87-a"));
        assert(
          r.code === "not_github" && refs(away) === "",
          "an insteadOf rewrite away from github.com is refused with not_github and nothing reaches the rewritten host, by the run's push",
        );
      }
      {
        const w = ghRepo("87-b");
        const away = newBare();
        sh("git", ["config", `url.ssh://elsewhere.invalid${away}.insteadOf`, "https://github.com/acme/w.git"], w);
        const withToken = codeOf(() => pushAsAgent({ worktree: w, env: agentEnv }));
        const withoutToken = codeOf(() => pushAsAgent({ worktree: w, env: { XDG_CONFIG_HOME: tempDir() } }));
        assert(
          withToken.code === "not_github" && withoutToken.code === "not_github" && refs(away) === "",
          "an insteadOf rewrite away from github.com is refused with not_github and nothing reaches the rewritten host, by factory push",
        );
      }
      {
        const w = ghRepo("87-c");
        const away = newBare();
        sh("git", ["config", `url.ssh://elsewhere.invalid${away}.pushInsteadOf`, "https://github.com/acme/w.git"], w);
        const run = codeOf(runPush(w, "87-c"));
        const plain = codeOf(() => pushAsAgent({ worktree: w, env: agentEnv }));
        assert(
          run.code === "not_github" && plain.code === "not_github" && refs(away) === "",
          "a pushInsteadOf rewrite away from github.com is refused with not_github and nothing reaches the rewritten host",
        );
      }
      {
        // GitHub over ssh pushes with the operator's key, never the agent's
        // https helper, so it is refused like any other host.
        const results = ["git@github.com:", "ssh://git@github.com/", "elsewhere.example:"].map((base) => {
          const w = ghRepo("87-d");
          sh("git", ["config", `url.${base}.insteadOf`, "https://github.com/"], w);
          return codeOf(runPush(w, "87-d")).code === "not_github" && codeOf(() => pushAsAgent({ worktree: w, env: agentEnv })).code === "not_github";
        });
        assert(results.every(Boolean), "ssh rewrites of the push URL (git@github.com:, ssh://github.com/ and a user-less host:path) are refused with not_github");
      }
      {
        // A local origin is pushed by name, so its pushurl and pushInsteadOf apply.
        const viaPushurl = (() => {
          const w = realpathSync(makeRepo({ branch: "87-e" }));
          const local = newBare();
          const away = newBare();
          sh("git", ["remote", "add", "origin", local], w);
          sh("git", ["config", "remote.origin.pushurl", `ssh://elsewhere.invalid${away}`], w);
          return codeOf(runPush(w, "87-e")).code === "not_github" && refs(away) === "" && refs(local) === "";
        })();
        const viaPushInsteadOf = (() => {
          const w = realpathSync(makeRepo({ branch: "87-e" }));
          const local = newBare();
          const away = newBare();
          sh("git", ["remote", "add", "origin", local], w);
          sh("git", ["config", `url.ssh://elsewhere.invalid${away}.pushInsteadOf`, local], w);
          return codeOf(runPush(w, "87-e")).code === "not_github" && refs(away) === "" && refs(local) === "";
        })();
        const stillLocal = (() => {
          const w = realpathSync(makeRepo({ branch: "87-e" }));
          const local = newBare();
          const mirror = newBare();
          sh("git", ["remote", "add", "origin", local], w);
          sh("git", ["config", "remote.origin.pushurl", mirror], w);
          return codeOf(runPush(w, "87-e")).code === "ok" && refs(mirror) !== "";
        })();
        assert(
          viaPushurl && viaPushInsteadOf && stillLocal,
          "a local origin whose pushurl or pushInsteadOf leaves the machine is refused with not_github and nothing is pushed",
        );
      }
      {
        const w = realpathSync(makeRepo({ branch: "87-f", origin: "elsewhere.example:acme/w.git" }));
        const host = remoteOf(w, "acme/w").host;
        const r = codeOf(() => pushAsAgent({ worktree: w, env: agentEnv }));
        assert(
          host === "elsewhere.example" && r.code === "not_github" && r.detail?.cause === "origin_host",
          "a user-less scp-style origin (host:path) has its host and is refused as off github.com",
        );
      }
      {
        const off = realpathSync(makeRepo({ branch: "87-g", origin: "https://gitlab.com/acme/w.git" }));
        const byOrigin = codeOf(runPush(off, "87-g"));
        const w = ghRepo("87-g");
        sh("git", ["config", "url.https://user:s3cret-pw@elsewhere.invalid/.insteadOf", "https://github.com/"], w);
        const byRewrite = codeOf(runPush(w, "87-g"));
        assert(
          byOrigin.code === "not_github" &&
            byOrigin.detail?.cause === "origin_host" &&
            byOrigin.detail?.host === "gitlab.com" &&
            byRewrite.code === "not_github" &&
            byRewrite.detail?.cause === "push_url" &&
            byRewrite.detail?.resolved_url === "https://elsewhere.invalid/acme/w.git" &&
            byRewrite.message.includes("https://elsewhere.invalid/acme/w.git") &&
            !byRewrite.message.includes("origin is on") &&
            !JSON.stringify(byRewrite).includes("s3cret") &&
            !JSON.stringify(byRewrite).includes(TOKEN),
          "not_github tells an origin off github.com from a rewritten push URL, with the resolved URL and no credentials",
        );
      }
      {
        const w = ghRepo("87-h");
        const away = newBare();
        sh("git", ["config", `url.ssh://elsewhere.invalid${away}.insteadOf`, "https://github.com/acme/w.git"], w);
        const factorySh = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "factory.sh");
        const cli = (args: string[]) => {
          const res = spawnSync("bash", [factorySh, "--json", ...args], {
            cwd: w,
            env: { ...process.env, ...agentEnv, XDG_DATA_HOME: tempDir() },
            encoding: "utf-8",
          });
          return JSON.parse(res.stdout) as { ok: boolean; error?: { code: string; detail?: Record<string, unknown> } };
        };
        const pushed = cli(["push"]);
        const usage = cli(["start"]);
        assert(
          pushed.ok === false &&
            pushed.error?.code === "not_github" &&
            pushed.error.detail?.cause === "push_url" &&
            pushed.error.detail?.resolved_url === `ssh://elsewhere.invalid${away}` &&
            usage.ok === false &&
            usage.error?.code === "usage" &&
            !("detail" in (usage.error ?? {})) &&
            refs(away) === "",
          "the factory CLI reports the not_github cause in error.detail and adds no detail to other errors",
        );
      }
      {
        // The resolver agrees with git's own expansion of a configured remote.
        const w = ghRepo("87-i");
        sh("git", ["config", "url.ssh://a.invalid/.insteadOf", "https://github.com/"], w);
        sh("git", ["config", "url.ssh://b.invalid/acme/.insteadOf", "https://github.com/acme/"], w);
        sh("git", ["config", "url./srv/mirror/.pushInsteadOf", "https://github.com/acme/w"], w);
        sh("git", ["remote", "add", "probe", "https://github.com/acme/w.git"], w);
        sh("git", ["remote", "add", "probe2", "https://github.com/other/x.git"], w);
        const agrees =
          resolvePushUrl(w, "https://github.com/acme/w.git") === sh("git", ["remote", "get-url", "--push", "probe"], w) &&
          resolvePushUrl(w, "https://github.com/other/x.git") === sh("git", ["remote", "get-url", "--push", "probe2"], w) &&
          resolvePushUrl(w, "https://github.com/other/x.git") === sh("git", ["ls-remote", "--get-url", "https://github.com/other/x.git"], w);
        assert(agrees, "the push URL resolver agrees with git: longest prefix, pushInsteadOf before insteadOf");
      }
      assert(
        urlHost("git@github.com:a/b") === "github.com" &&
          urlHost("host.example:a/b") === "host.example" &&
          urlHost("ssh://git@host.example:2222/a") === "host.example" &&
          urlHost("file:///srv/a.git") === null &&
          urlHost("file://localhost/srv/a.git") === null &&
          urlHost("/srv/a.git") === null &&
          urlHost("./dir:with-colon/a.git") === null &&
          redactUrl("https://u:p@h.example/x") === "https://h.example/x",
        "hosts are read the way git reads them, and userinfo is redacted",
      );
    } finally {
      if (saved.cmd === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = saved.cmd;
      if (saved.variant === undefined) delete process.env.GIT_SSH_VARIANT;
      else process.env.GIT_SSH_VARIANT = saved.variant;
    }
  }

  console.log("\nfactory push (no run)\n");
  {
    const agentEnv = { XDG_CONFIG_HOME: tempDir(), [TOKEN_VAR]: TOKEN };
    const noToken = { XDG_CONFIG_HOME: tempDir() };
    const settings = "## Escapement Settings\n\n- **base-branch**: develop\n";
    const w = realpathSync(makeRepo({ branch: "80-work", origin: "git@github.com:acme/p.git", claudeMd: settings }));
    const pbare = join(tempDir(), "p.git");
    sh("git", ["init", "-q", "--bare", pbare], tempDir());
    sh("git", ["config", `url.${pbare}.insteadOf`, "https://github.com/acme/p.git"], w);
    sh("git", ["branch", "other"], w);
    const pushed = () => sh("git", ["for-each-ref", "--format=%(refname)", "refs/heads"], pbare);
    const fails = (fn: () => unknown, code: string): boolean => {
      try {
        fn();
        return false;
      } catch (err) {
        return String((err as Error).message).includes(code) || (err as { code?: string }).code === code;
      }
    };

    const before = pushed();
    const tokenless = fails(() => pushAsAgent({ worktree: w, env: noToken }), "no_agent_token");
    assert(tokenless && before === "" && pushed() === "", "factory push without an agent token is no_agent_token and pushes nothing");

    const res = pushAsAgent({ worktree: w, env: agentEnv });
    const head = sh("git", ["rev-parse", "HEAD"], w);
    assert(
      sh("git", ["rev-parse", "refs/remotes/origin/80-work"], w) === head &&
        sh("git", ["rev-parse", "--abbrev-ref", "80-work@{upstream}"], w) === "origin/80-work" &&
        sh("git", ["rev-list", "--count", "@{upstream}..HEAD"], w) === "0",
      "factory push records the pushed branch as origin's and sets it as upstream",
    );
    const first =
      res.branch === "80-work" &&
      res.sha === head &&
      res.repo === "acme/p" &&
      res.remote === "https://github.com/acme/p.git" &&
      !JSON.stringify(res).includes(TOKEN) &&
      pushed() === "refs/heads/80-work" &&
      sh("git", ["rev-parse", "refs/heads/80-work"], pbare) === head;
    sh("git", ["commit", "-q", "--amend", "-m", "rewritten"], w);
    const forced = fails(() => pushAsAgent({ worktree: w, env: agentEnv }), "push_failed");
    const unchanged = sh("git", ["rev-parse", "refs/heads/80-work"], pbare) === head;
    assert(first && forced && unchanged, "factory push pushes the current branch as the agent and never forces");

    const refused = ["develop", "main", "master"].map((b) => {
      sh("git", ["checkout", "-q", "-b", b], w);
      const r = fails(() => pushAsAgent({ worktree: w, env: agentEnv }), "push_base_branch");
      sh("git", ["checkout", "-q", "80-work"], w);
      return r;
    });
    assert(refused.every(Boolean) && pushed() === "refs/heads/80-work", "factory push refuses the base branch, main and master");

    sh("git", ["checkout", "-q", "--detach"], w);
    assert(fails(() => pushAsAgent({ worktree: w, env: agentEnv }), "detached_head"), "factory push refuses a detached HEAD");
    sh("git", ["checkout", "-q", "80-work"], w);

    sh("git", ["update-ref", "refs/remotes/origin/trunk", "HEAD"], w);
    sh("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"], w);
    sh("git", ["checkout", "-q", "-b", "trunk"], w);
    const trunkRefused = fails(() => pushAsAgent({ worktree: w, env: agentEnv }), "push_base_branch");
    sh("git", ["checkout", "-q", "80-work"], w);
    assert(trunkRefused && pushed() === "refs/heads/80-work", "factory push refuses origin's default branch");

    // Off github.com the token is never offered. insteadOf would carry each
    // push to a local bare repo, so only the refusal keeps them empty.
    const offHosts = [
      { origin: "git@gitlab.com:acme/p.git", url: "https://gitlab.com/acme/p.git" },
      { origin: "https://ghe.example.com/acme/p.git", url: "https://ghe.example.com/acme/p.git" },
      { origin: "ssh://git@git.internal.example:2222/acme/p.git", url: "https://git.internal.example/acme/p.git" },
    ];
    const offResults = offHosts.map(({ origin, url }) => {
      const r = realpathSync(makeRepo({ branch: "80-work", origin }));
      const ob = join(tempDir(), "off.git");
      sh("git", ["init", "-q", "--bare", ob], tempDir());
      sh("git", ["config", `url.${ob}.insteadOf`, url], r);
      const withToken = fails(() => pushAsAgent({ worktree: r, env: agentEnv }), "not_github");
      const withoutToken = fails(() => pushAsAgent({ worktree: r, env: noToken }), "not_github");
      const empty = sh("git", ["for-each-ref"], ob) === "";
      return { r, ob, url, ok: withToken && withoutToken && empty };
    });
    assert(offResults.every((x) => x.ok), "factory push never sends the agent token to a host that isn't github.com");

    const off = offResults[0];
    const runPushRefused = fails(
      () => pushBranch({ worktree: off.r, remote: remoteOf(off.r, "acme/p"), repo: "acme/p", branch: "80-work", token: TOKEN }),
      "not_github",
    );
    assert(runPushRefused && sh("git", ["for-each-ref"], off.ob) === "", "the run's push refuses a host that isn't github.com before using the token");

    const plain = realpathSync(makeRepo({ branch: "develop", origin: "git@github.com:acme/q.git" }));
    sh("git", ["update-ref", "refs/remotes/origin/develop", "HEAD"], plain);
    assert(fails(() => pushAsAgent({ worktree: plain, env: agentEnv }), "push_base_branch"), "without base-branch, the default target branch is refused");
  }

  cleanup();
  console.log("\nAll GitHub access tests passed.");
}

run().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
