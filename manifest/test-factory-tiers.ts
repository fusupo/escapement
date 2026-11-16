import { matchesGlob } from "./factory/glob.ts";
import { assessTier } from "./factory/tiers.ts";
import { assert } from "./factory/testkit.ts";

function globs() {
  console.log("Glob matching\n");

  const yes = (path: string, pattern: string) => assert(matchesGlob(path, pattern), `${pattern} matches ${path}`);
  const no = (path: string, pattern: string) => assert(!matchesGlob(path, pattern), `${pattern} doesn't match ${path}`);

  yes("src/auth/refresh.ts", "src/auth/**");
  yes("src/auth/deep/nested/x.ts", "src/auth/**");
  no("src/authz/x.ts", "src/auth/**");
  no("lib/src/auth/x.ts", "src/auth/**");
  yes("src/auth/x.ts", "/src/auth/**");

  yes("package.json", "package.json");
  yes("packages/web/package.json", "package.json");
  no("package.json.bak", "package.json");
  yes("jest.config.ts", "jest.config.*");
  yes("tsconfig.build.json", "tsconfig*.json");
  yes(".eslintrc.cjs", ".eslintrc*");
  no("src/config.ts", "jest.config.*");

  yes("skills/do-work/SKILL.md", "skills/**");
  yes("CLAUDE.md", "CLAUDE.md");
  yes(".github/workflows/ci.yml", ".github/**");

  yes("a/b/test/x.ts", "**/test/**");
  yes("test/x.ts", "**/test/**");
  yes("db/migrations/001.sql", "**/migrations/*.sql");
  yes("migrations/001.sql", "**/migrations/*.sql");
  no("migrations/sub/001.sql", "**/migrations/*.sql");

  yes("src/a.ts", "src/*.ts");
  no("src/sub/a.ts", "src/*.ts");
  yes("v1.ts", "v?.ts");
  no("v10.ts", "v?.ts");

  yes("docs/x.md", "docs/");
  no("docs", "docs/");
  yes("docs/x.md", "docs");
  yes("./src/auth/x.ts", "src/auth/**");
  yes("file(1).ts", "file(1).ts");
  no("file1.ts", "file(1).ts");
  yes("a+b.ts", "a+b.ts");
}

function tiers() {
  console.log("\nRisk tiers\n");

  const settings = { sensitivePaths: ["src/auth/**", "migrations/**"], validationFiles: ["package.json", "jest.config.*"] };

  const plain = assessTier({ files: ["src/ui/button.tsx", "README.md"], settings });
  assert(plain.tier === "standard" && plain.reasons.length === 0, "ordinary files are standard");

  const auth = assessTier({ files: ["src/auth/refresh.ts", "src/ui/x.ts"], settings });
  assert(auth.tier === "sensitive", "a sensitive path makes the run sensitive");
  assert(auth.reasons[0] === "sensitive path: src/auth/refresh.ts (matches src/auth/**)", "the reason names the file and the pattern");

  const policy = assessTier({ files: ["jest.config.js"], settings });
  assert(policy.tier === "sensitive" && policy.reasons[0].startsWith("execution policy: jest.config.js"), "a validation file is an execution-policy change");

  const proposed = assessTier({ files: ["src/ui/x.ts"], settings, proposed: "sensitive", reasons: ["public API change"] });
  assert(proposed.tier === "sensitive" && proposed.reasons.join() === "public API change", "a proposed sensitive tier is kept with its reasons");
  const bare = assessTier({ files: [], settings, proposed: "sensitive" });
  assert(bare.tier === "sensitive" && bare.reasons.join() === "proposed as sensitive", "a sensitive tier always has a reason");
  const lower = assessTier({ files: ["migrations/002.sql"], settings, proposed: "standard" });
  assert(lower.tier === "sensitive", "the higher tier wins over a standard proposal");

  const none = assessTier({ files: ["src/auth/x.ts"], settings: { sensitivePaths: [], validationFiles: [] } });
  assert(none.tier === "standard", "without sensitive-paths nothing is sensitive by path");
}

globs();
tiers();
console.log("\nAll factory tier tests passed.");
