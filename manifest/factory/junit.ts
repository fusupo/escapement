import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { FactoryError } from "./util.ts";

/**
 * JUnit XML results (the `junit:` test-results format, §4.4) and resolving
 * contract `test` selectors against them.
 *
 * JUnit XML has no single standard. The shapes handled are those jest-junit,
 * vitest, pytest, node:test and Go/Java tools write: a `<testsuites>` or
 * lone `<testsuite>` root, nested suites, `<testcase>` with `name`,
 * `classname` and sometimes `file`, and `<failure>`, `<error>` or
 * `<skipped>` children.
 */

export type CaseStatus = "passed" | "failed" | "error" | "skipped";

export type TestCase = {
  name: string;
  classname: string | null;
  /** The case's `file` attribute, else its nearest suite's `file` or `filepath`. */
  file: string | null;
  /** Names of the enclosing suites, outermost first. */
  suites: string[];
  status: CaseStatus;
  /** The failure, error or skip message (attribute, else element text). */
  message: string | null;
  /** The results file it was read from. */
  source: string;
};

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  processEntities: true,
  isArray: (name) => ["testsuite", "testcase", "failure", "error", "skipped"].includes(name),
});

function attr(n: Node, name: string): string | null {
  const v = n[`@${name}`];
  return typeof v === "string" ? v : v === undefined || v === null ? null : String(v);
}

function messageOf(children: unknown): string | null {
  const first = Array.isArray(children) ? children[0] : children;
  if (first === undefined || first === null) return null;
  if (typeof first === "string") return first.trim() || null;
  const n = first as Node;
  const text = typeof n["#text"] === "string" ? (n["#text"] as string).trim() : "";
  return attr(n, "message") ?? (text || null);
}

/** Every testcase in one JUnit XML document. */
export function parseJUnit(xml: string, source = "(inline)"): TestCase[] {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    throw new FactoryError("bad_results", `${source} is not valid XML: ${valid.err.msg} (line ${valid.err.line})`);
  }
  const doc = parser.parse(xml) as Node;
  const cases: TestCase[] = [];
  const walk = (suite: Node, names: string[], file: string | null) => {
    const name = attr(suite, "name");
    const here = name !== null ? [...names, name] : names;
    const suiteFile = attr(suite, "file") ?? attr(suite, "filepath") ?? file;
    for (const tc of (suite.testcase as Node[] | undefined) ?? []) {
      const node = (typeof tc === "object" && tc !== null ? tc : {}) as Node;
      const status: CaseStatus = node.error
        ? "error"
        : node.failure
          ? "failed"
          : node.skipped || attr(node, "status") === "skipped" || attr(node, "status") === "disabled"
            ? "skipped"
            : "passed";
      cases.push({
        name: attr(node, "name") ?? "",
        classname: attr(node, "classname"),
        file: attr(node, "file") ?? suiteFile,
        suites: here,
        status,
        message: messageOf(node.error ?? node.failure ?? node.skipped),
        source,
      });
    }
    for (const child of (suite.testsuite as Node[] | undefined) ?? []) walk(child, here, suiteFile);
  };
  if ("testsuites" in doc) {
    // An empty <testsuites/> parses as a string.
    const root = (typeof doc.testsuites === "object" && doc.testsuites !== null ? doc.testsuites : {}) as Node;
    for (const s of (root.testsuite as Node[] | undefined) ?? []) walk(s, [], null);
  } else if (doc.testsuite) {
    for (const s of doc.testsuite as Node[]) walk(s, [], null);
  } else {
    throw new FactoryError("bad_results", `${source} has no <testsuites> or <testsuite> root`);
  }
  return cases;
}

/** All `.xml` files under `dir` (recursively), sorted. */
export function resultFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const entry of readdirSync(d).sort()) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) visit(p);
      else if (entry.endsWith(".xml")) out.push(p);
    }
  };
  visit(dir);
  return out;
}

/** Every testcase in the given results files. */
export function readResults(files: readonly string[]): TestCase[] {
  return files.flatMap((f) => parseJUnit(readFileSync(f, "utf-8"), f));
}

// ── selectors ────────────────────────────────────────────────────────

export type Selector = { path: string; name: string | null };

/** `tests/a.test.ts::rejects expired token` → path and name; a bare path selects every test in the file. */
export function parseSelector(selector: string): Selector {
  const i = selector.indexOf("::");
  const path = (i === -1 ? selector : selector.slice(0, i)).trim().replace(/^\.\//, "");
  const name = i === -1 ? null : selector.slice(i + 2).trim() || null;
  return { path, name };
}

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Whether a case belongs to `path`: by its `file`, else by a classname or
 * suite name that is the path (vitest), else by a dotted classname
 * (pytest's `tests.test_auth`). jest-junit writes no path unless
 * `addFileAttribute` is on.
 */
function inFile(c: TestCase, path: string): boolean {
  const want = norm(path);
  const isPath = (p: string) => {
    const f = norm(p);
    return f === want || f.endsWith(`/${want}`);
  };
  if (c.file !== null) return isPath(c.file);
  if ((c.classname && isPath(c.classname)) || c.suites.some(isPath)) return true;
  if (c.classname) {
    const dotted = want.replace(/\.[^./]+$/, "").replace(/\//g, ".");
    const cls = c.classname;
    return cls === dotted || cls.startsWith(`${dotted}.`) || cls.endsWith(`.${dotted}`) || cls.includes(`.${dotted}.`);
  }
  return false;
}

function wildcard(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

/**
 * Whether a case is the test `name` names: its name, or the end of its
 * full name (suites, classname and name joined by spaces, as jest-junit
 * writes `describe it`). `*` in the name is a wildcard.
 */
function named(c: TestCase, name: string): boolean {
  const full = [...c.suites, c.classname ?? "", c.name].filter(Boolean).join(" ");
  if (name.includes("*")) {
    const re = wildcard(name);
    return re.test(c.name) || re.test(full);
  }
  return c.name === name || c.name.endsWith(` ${name}`) || full.endsWith(` ${name}`);
}

export type Resolution = {
  /** passed only when at least one case matched and every match passed. */
  executed: "passed" | "failed" | "skipped" | "not_found" | "error";
  cases: TestCase[];
  /** The first failure or skip message among the matches. */
  message: string | null;
};

/** Resolve a contract `test` selector against executed cases (§4.4): skipped and not_found are failures. */
export function resolveSelector(selector: string, cases: readonly TestCase[]): Resolution {
  const s = parseSelector(selector);
  const matches = cases.filter((c) => inFile(c, s.path) && (s.name === null || named(c, s.name)));
  if (matches.length === 0) return { executed: "not_found", cases: [], message: null };
  const worst = (["error", "failed", "skipped"] as const).find((st) => matches.some((c) => c.status === st));
  const message = worst ? (matches.find((c) => c.status === worst)!.message ?? null) : null;
  return { executed: worst ?? "passed", cases: matches, message };
}

/** Cases that actually ran (passed, failed or errored); skipped cases didn't execute. */
export function executedCount(cases: readonly TestCase[]): number {
  return cases.filter((c) => c.status !== "skipped").length;
}
