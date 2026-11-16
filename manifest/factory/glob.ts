/**
 * Glob patterns for `sensitive-paths` and `validation-files`, matched against
 * repository-relative paths with `/` separators. The rules follow
 * .gitignore, which is what people writing these lists expect:
 *
 * - `*` matches within one path segment, `?` one character other than `/`.
 * - `**` matches any number of segments, including none: `src/**` is
 *   everything under src, and a leading `**` segment before `/test` matches
 *   test at any depth.
 * - A pattern with no `/` except a trailing one matches at any depth
 *   (`package.json`, `jest.config.*`, `CLAUDE.md`).
 * - A pattern with a `/` is anchored at the repository root; a leading `/`
 *   only makes that explicit.
 * - A trailing `/` means a directory: everything under it matches.
 *
 * Braces, character classes and negation aren't supported; their characters
 * match literally.
 */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim();
  let dirOnly = false;
  if (p.endsWith("/")) {
    dirOnly = true;
    p = p.replace(/\/+$/, "");
  }
  const anchored = p.includes("/");
  p = p.replace(/^\/+/, "");

  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      const atStart = i === 0 || p[i - 1] === "/";
      const atEnd = i + 2 === p.length || p[i + 2] === "/";
      if (atStart && atEnd) {
        if (i + 2 === p.length) {
          re += ".*"; // trailing **: everything below
        } else {
          re += "(?:.*/)?"; // **/ : zero or more leading segments
          i++; // also skip the slash below
        }
        i++;
        continue;
      }
      // ** inside a segment acts like *
      re += "[^/]*";
      i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }

  const prefix = anchored ? "^" : "^(?:.*/)?";
  const suffix = dirOnly ? "/.*$" : "(?:/.*)?$";
  return new RegExp(prefix + re + suffix);
}

/** True when `path` matches `pattern` (see globToRegExp). */
export function matchesGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path.replace(/^\.\//, ""));
}

/** The first pattern in `patterns` that matches `path`, or null. */
export function firstMatch(path: string, patterns: readonly string[]): string | null {
  return patterns.find((p) => matchesGlob(path, p)) ?? null;
}
