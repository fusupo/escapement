// Reviewer leftovers (#120): small runner follow-ups from the #87, #97 and
// #117 reviews, each tested here so the existing suites keep their
// assertions as they were.
import { spawnSync } from "node:child_process";
import { gh } from "./factory/github.ts";
import { assert, cleanup, stubGh } from "./factory/testkit.ts";

const TOKEN = "ghp_test_agent_token_120";

function stubEnterpriseToken() {
  console.log("The gh stub and GITHUB_ENTERPRISE_TOKEN (item 8)\n");
  const stub = stubGh();
  // Run the stub directly with the variable set: it must log it, or the
  // drop test below would pass whatever gh() does.
  const direct = spawnSync("gh", ["api", "user"], {
    env: { ...process.env, PATH: stub.path, GITHUB_ENTERPRISE_TOKEN: "ent-direct" },
    encoding: "utf-8",
  });
  const seen = stub.calls().at(-1);
  assert(direct.status === 0 && seen?.githubEnterpriseToken === "ent-direct", "the gh stub logs GITHUB_ENTERPRISE_TOKEN when it is set");

  gh(["api", "user"], { token: TOKEN, env: { ...process.env, PATH: stub.path, GITHUB_ENTERPRISE_TOKEN: "ent-token" } });
  const call = stub.calls().at(-1)!;
  assert(call.githubEnterpriseToken === null && call.token === TOKEN, "gh drops GITHUB_ENTERPRISE_TOKEN so the stub never sees it");
}

async function run() {
  stubEnterpriseToken();
}

run()
  .then(() => console.log("\nAll reviewer-leftover checks passed."))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(cleanup);
