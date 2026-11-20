Shared test cases for the context-path parsers:
  scripts/get-context-path.sh   (scripts/test-get-context-path.sh)
  manifest/init.ts              (manifest/test-init.ts)
  scripts/migrate-archives.py   (scripts/test-migrate-archives.py)

Each case starts with a line of the form

  === case: NAME | expect: VALUE | warnings: N

and its body, up to the next "===" line, is a sample CLAUDE.md. An empty
VALUE means no setting is found. Everything above the first case is ignored.
Cases that depend on exact whitespace (CRLF line endings, trailing tabs) are
built inline in each test instead, since editors tend to strip them.

Worktree cases (#88) come first, above the first case, so the parsers'
loaders above skip them. Their tests build a real repository and resolve
context-path from a linked worktree outside the repository's parent
directory:
  scripts/get-context-path.sh --absolute   (scripts/test-context-worktree.sh)
  manifest/factory/context.ts              (manifest/test-context-worktree.ts)
    resolveContextPath
  scripts/migrate-archives.py              (scripts/test-context-worktree.py)
    detect_context_path

Each starts with a line of the form

  === worktree: NAME | expect: VALUE

and its body, up to the next "===" line, is the main checkout's CLAUDE.md.
The worktree's own CLAUDE.md (the committed one) always sets
"../wrong-ctx", so a case only passes when the main checkout's file is read.
In VALUE, {main} is the main checkout's physical path and {parent} its
parent directory; an empty VALUE means no setting is found. Every case must
give the same VALUE from the worktree, a subdirectory of it, the main
checkout and a subdirectory of that.

=== worktree: sibling | expect: {parent}/wt-ctx
## Escapement Settings

- **context-path**: ../wt-ctx

=== worktree: inside-main-checkout | expect: {main}/.ctx/notes
## Escapement Settings

- **context-path**: .ctx/notes

=== worktree: dot-segments | expect: {main}/b-ctx
## Escapement Settings

- **context-path**: ./a/../b-ctx

=== worktree: absolute | expect: /escapement-test-ctx/shared
## Escapement Settings

- **context-path**: /escapement-test-ctx/./x/../shared

=== worktree: quoted-with-spaces | expect: {parent}/my ctx
## Escapement Settings

- **context-path**: "../my ctx"

=== worktree: fenced-example-first | expect: {parent}/real-ctx
# Project

```markdown
## Escapement Settings

- **context-path**: ../example-ctx
```

## Escapement Settings

- **context-path**: ../real-ctx

=== worktree: main-has-no-setting | expect: 
# Project

Nothing configured here, although the worktree's own CLAUDE.md sets one.


=== case: fenced-example-first | expect: ../real-ctx | warnings: 0
# Project

## Context Path (Optional)

```markdown
## Escapement Settings

- **context-path**: ../myproject-ctx
```

## Escapement Settings

- **context-path**: ../real-ctx

## Project Context

=== case: nested-fence | expect: ../nested-ctx | warnings: 0
## Escapement Settings

````markdown
```
- **context-path**: ../inner-ctx
```
- **context-path**: ../still-fenced-ctx
````

~~~
- **context-path**: ../tilde-ctx
~~~

  ```text
  - **context-path**: ../indented-fence-ctx
  ```

- **context-path**: ../nested-ctx

=== case: no-section | expect:  | warnings: 0
# Project

Nothing configured here.

=== case: section-without-setting | expect:  | warnings: 0
## Escapement Settings

- **other-setting**: foo

## Next

=== case: setting-outside-section | expect:  | warnings: 1
## Configuration

- **context-path**: ../stray-ctx

## Escapement Settings

Nothing here.

=== case: outside-and-inside | expect: ../real-ctx | warnings: 1
- **context-path**: ../stray-ctx

## Escapement Settings

- **context-path**: ../real-ctx

=== case: second-section | expect: ../first-ctx | warnings: 1
## Escapement Settings

- **context-path**: ../first-ctx

## Escapement Settings

- **context-path**: ../second-ctx

=== case: subheading | expect: ../sub-ctx | warnings: 1
## Escapement Settings

### Paths

- **context-path**: ../sub-ctx

# Top-level heading

- **context-path**: ../after-ctx

=== case: double-quoted | expect: ../my ctx | warnings: 0
## Escapement Settings
- **context-path**: "../my ctx"

=== case: single-quoted | expect: ../single-ctx | warnings: 0
## Escapement Settings
- **context-path**: '../single-ctx'

=== case: backticked | expect: ../tick-ctx | warnings: 0
## Escapement Settings
- **context-path**: `../tick-ctx`

=== case: star-bullet | expect: ../star-ctx | warnings: 0
## Escapement Settings
* **context-path**: ../star-ctx

=== case: empty-value | expect:  | warnings: 0
## Escapement Settings
- **context-path**:
