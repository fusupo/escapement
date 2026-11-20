// The gh-caller guard, per function (#120, item 7; #87 and #117 reviewers).
//
// Every gh()/ghJson() call carries the agent token, so the function that
// makes it must check the host first: assertTokenHost, or assertPushTarget
// before a push. test-factory-github.ts checks this per file, before the
// first call only, so a later call in another function (backfillMergeShas
// in archive.ts, say) wasn't covered. This test parses each runner file with
// the TypeScript compiler and checks every call in every function.
//
// - A function is a top-level named function, or a top-level `const` bound
//   to an arrow or function expression. Calls inside nested arrows and
//   callbacks count toward it (archiveRun's ghJson runs inside withLocks).
// - A call is guarded when a host check comes earlier in the same function.
// - agentIdentity is exempt: `gh api user` has no origin to check, and the
//   GH_HOST pin in gh() covers it. So are gh and ghJson themselves.
// - A gh call outside any function is reported.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { assert } from "./factory/testkit.ts";

const GH = new Set(["gh", "ghJson"]);
const GUARDS = new Set(["assertTokenHost", "assertPushTarget"]);
const EXEMPT = new Set(["agentIdentity", "gh", "ghJson"]);

interface Call {
  fn: string | null;
  callee: string;
  line: number;
  guarded: boolean;
}

/** Every gh()/ghJson() call in `source`, with its enclosing function and whether a host check precedes it there. */
function ghCalls(source: string, fileName = "source.ts"): Call[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: Call[] = [];
  const calleeName = (n: ts.CallExpression) => (ts.isIdentifier(n.expression) ? n.expression.text : null);

  const scan = (fn: string | null, body: ts.Node) => {
    const guards: number[] = [];
    const found: { callee: string; pos: number }[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const name = calleeName(n);
        if (name && GUARDS.has(name)) guards.push(n.getStart(sf));
        if (name && GH.has(name)) found.push({ callee: name, pos: n.getStart(sf) });
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    for (const c of found) {
      calls.push({
        fn,
        callee: c.callee,
        line: sf.getLineAndCharacterOfPosition(c.pos).line + 1,
        guarded: guards.some((g) => g < c.pos),
      });
    }
  };

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      scan(stmt.name.text, stmt);
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) scan(d.name.text, init);
        else scan(null, d);
      }
      continue;
    }
    scan(null, stmt);
  }
  return calls;
}

/** The calls the guard rule rejects: no host check earlier in the same function, outside the exemptions. */
function unguardedCalls(source: string, fileName?: string): Call[] {
  return ghCalls(source, fileName).filter((c) => !c.guarded && !(c.fn && EXEMPT.has(c.fn)));
}

const here = dirname(fileURLToPath(import.meta.url));
const factoryDir = join(here, "factory");
const runnerFiles = [
  ...readdirSync(factoryDir)
    .filter((f) => f.endsWith(".ts") && f !== "testkit.ts")
    .map((f) => join("factory", f)),
  "factory-cli.ts",
];

function realRunner() {
  console.log("The runner's gh callers\n");
  const all = runnerFiles.flatMap((f) => ghCalls(readFileSync(join(here, f), "utf-8"), f).map((c) => ({ ...c, file: f })));
  const bad = all.filter((c) => !c.guarded && !(c.fn && EXEMPT.has(c.fn)));
  for (const c of bad) console.error(`  unguarded: ${c.file}:${c.line} ${c.callee}() in ${c.fn ?? "(top level)"}`);
  assert(bad.length === 0, "every function in the runner that calls gh or ghJson checks the host first, agentIdentity excepted");

  const callers = new Set(all.map((c) => `${c.file}:${c.fn}`));
  assert(
    ["factory/archive.ts:backfillMergeShas", "factory/archive.ts:archiveRun", "factory/pr.ts:openPr", "factory/github.ts:agentIdentity"].every((k) =>
      callers.has(k),
    ) &&
      all.filter((c) => c.file === "factory/archive.ts" && c.fn === "backfillMergeShas" && c.callee === "ghJson").length === 1 &&
      all.some((c) => c.file === "factory/archive.ts" && c.fn === "archiveRun" && c.guarded),
    "the guard check finds the real gh callers, backfillMergeShas and archiveRun included",
  );
}

function synthetic() {
  console.log("\nThe guard check on synthetic sources\n");
  const none = unguardedCalls(`
    export function lookup(token: string) {
      return ghJson<{ n: number }>(["pr", "view", "1"], { token });
    }
    const viaArrow = (token: string) => gh(["api", "user"], { token });
    export function fine(remote: Remote, token: string) {
      assertTokenHost(remote);
      return gh(["pr", "list"], { token });
    }
  `);
  assert(
    none.length === 2 &&
      none.some((c) => c.fn === "lookup" && c.callee === "ghJson") &&
      none.some((c) => c.fn === "viaArrow" && c.callee === "gh") &&
      !none.some((c) => c.fn === "fine"),
    "the guard check reports a function that calls gh with no host check",
  );

  const misplaced = unguardedCalls(`
    export function late(remote: Remote, token: string) {
      const out = gh(["pr", "list"], { token });
      assertTokenHost(remote);
      return out;
    }
    export function checks(remote: Remote) {
      assertPushTarget("/w", remote, "acme/w");
    }
    export function elsewhere(token: string) {
      return withLocks(() => ghJson<number>(["api", "x"], { token }));
    }
    gh(["api", "user"], { token: "t" });
  `);
  assert(
    misplaced.length === 3 &&
      misplaced.some((c) => c.fn === "late") &&
      misplaced.some((c) => c.fn === "elsewhere" && c.callee === "ghJson") &&
      misplaced.some((c) => c.fn === null) &&
      !misplaced.some((c) => c.fn === "checks"),
    "the guard check reports a host check that comes after the gh call or sits in another function",
  );
}

try {
  realRunner();
  synthetic();
  console.log("\nAll gh-guard checks passed.");
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
