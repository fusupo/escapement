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
