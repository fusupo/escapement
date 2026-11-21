# Session Archiving

Automatically archive Claude Code session logs before compaction occurs.

## Overview

Claude Code has an auto-compaction feature that triggers when the conversation context approaches token limits. When this happens, conversation history is condensed, potentially losing valuable implementation details, decisions, and troubleshooting context.

This hook-based system:
1. Detects when compaction is about to occur
2. Writes the part of the session transcript (JSONL) that no earlier log covers to your project root
3. Allows compaction to proceed normally
4. The `archive-work` skill later saves the rest of the session, and of every other session that worked on the issue, and converts the logs to readable markdown

## Quick Setup

Escapement registers the hook automatically via `hooks/hooks.json` when loaded as a plugin:

```bash
claude --plugin-dir /path/to/escapement
```

The hook fires for both auto and manual compaction — no manual settings.json configuration needed.

## How It Works

### Trigger Condition

The hook triggers for **both auto and manual compaction**:

- **Auto-compaction**: When context window fills up, transcript is archived automatically
- **Manual `/compact`**: Run `/compact` anytime to capture the session and compact

This gives you flexibility to capture session logs when finishing work, even before the context window is full.

### What the Hook Does

The PreCompact hook is intentionally minimal:

1. Reads `transcript_path` and `session_id` from the hook input JSON
2. Runs `scripts/slice-session-log.sh`, which writes the raw JSONL lines no earlier log covers to `SESSION_LOG_{N}.jsonl` in the project root
3. Exits — no parsing, no formatting, no conversion

If the helper is missing or fails, the hook copies the whole transcript instead, so a log is never lost.

The hook's job is **preservation** (survive compaction), not **presentation**.

### What a Session Log Covers

A Claude Code transcript only grows: compaction appends to it and never truncates it. Copying it whole every time would make each log repeat the entire session. Instead, each `SESSION_LOG_{N}` holds only the stretch of the session that no earlier log covers:

- **At compaction (the hook):** from where the previous log stopped up to now. The stretch includes the previous compaction's summary, so a reader knows what came before.
- **At archive time (`archive-work` Phase 1.5):** the session's tail since the last log, so an issue's final stretch is archived with that issue instead of with whichever issue the next compaction happens in. `scripts/session-tail-gate.py` decides whether the tail is this issue's work (#123); if not, `archive-work` asks before including it. A tail left out goes into the next log.
- **A session's first log** starts at the beginning of the session.

Successive logs from one session are contiguous and never overlap: put together, they are the transcript.

**Whose tail it is.** Each transcript entry records its git branch and directory (`cwd`). The tail is included without a question when everything from the first entry on the current branch (the issue branch) onwards is on that branch, and everything before it is on a detached `HEAD` or the base branch (where setup-work often starts) and in this worktree: its root, or a directory below it after a `cd`. The base branch is `factory check`'s `target_ref`, else `develop` when origin has it, else `main`. `archive-work` asks when:

- another named branch appears anywhere;
- `HEAD` or base-branch entries come after the issue branch started;
- the issue branch never appears;
- an earlier entry is outside this worktree. That includes a session that started in the main checkout and then moved into the issue's worktree: the check can't tell that from unrelated work there, so it asks.

On the base branch itself or a detached HEAD, as when archiving from `develop` after a merge, there is no issue branch to anchor on: the tail is included only when every entry is on the current branch. Phase 1.6 (#89) uses the same script for each other session that worked on the issue: see below.

**How "where the previous log stopped" is tracked:** one cursor file per session, at `${XDG_STATE_HOME:-~/.local/state}/escapement/session-cursors/{session_id}`, holding the last transcript line written. With no usable cursor (the first log after upgrading Escapement, or a deleted cursor), the log starts at the session's last `compact_boundary` entry (the previous compaction), or at the beginning if the session has never compacted. Cursor files are a few bytes each and are never pruned; deleting them is safe.

Things to know:

- **Header timestamp:** the converted markdown's Timestamp is the log's first message, usually the previous compaction's summary, not the session start.
- **A log that follows an archive-time tail** opens mid-conversation, where the tail stopped, instead of with a compaction summary.
- **Partial last line:** if the transcript is mid-write, its incomplete last line is left for the next log.
- **Resumed sessions:** a session that continues under a new session id starts a new cursor, so its first log starts at the last compaction in its transcript and may repeat part of an earlier log.
- **Hook logs aren't tied to an issue:** the hook writes to the project root whatever branch you're on, and `archive-work` collects every `SESSION_LOG_*` it finds there. Logs in another worktree's root come in only through Phase 1.6, when their session worked on the issue.

### Other Sessions That Worked on the Issue

Phase 1.5 covers only the session running `archive-work`. Other sessions, such as a factory run's own session in its worktree, used to reach the archive only if they were compacted, and then only when their logs sat in the root being archived. `archive-work`'s Phase 1.6 finds them itself, so compacting first is optional (#89). `scripts/find-session-transcripts.py` does the finding:

- **Where it looks.** Claude Code keeps each session's transcript in `~/.claude/projects/{encoded cwd}/{session id}.jsonl` (or under `CLAUDE_CONFIG_DIR`). The encoded cwd is the path with every character that isn't a letter or digit turned into `-`. It looks only at this repository's worktrees (#129):
  - the main checkout and every worktree in `git worktree list`, including the prunable ones whose directory is gone;
  - every factory run recorded for this repository (`factory status --all`), so the current run's `worktree_path` and older runs' removed worktrees are found;
  - every worktree `scripts/worktree.sh` keeps.

  Transcripts outlive their worktrees, so a removed worktree's sessions are still found while something records it. A removed worktree nothing records, such as a pruned legacy worktree from before #88, is not.
- **Only this repository.** The encoding can't tell paths apart (`/` and `-` both become `-`): a sibling repository such as `escapement-foo`, or another repository's managed worktree, encodes like one of ours. So a transcript counts only when its first recorded directory is one of this repository's worktrees, or below it.
- **Which it keeps.** A transcript is the issue's when an entry ran on the issue branch, or in the run's worktree during the run's time (`started_at` to `ended_at`). A worktree path reused by a later run doesn't bring back earlier runs' sessions. The issue branch is the run's branch, else the scratchpad's `**Feature branch:**`, else the current branch.
- **What it saves.** Each session is sliced like the tail, from its own cursor, so nothing an earlier log or compaction wrote is repeated. Each slice goes through the same gate, with that session's own worktree as its root.
- **Logs the hook wrote elsewhere.** A `SESSION_LOG_*.jsonl` in another worktree's root that belongs to one of these sessions is gated where it is. Only an included one is moved into this root, by `slice-session-log.sh adopt`, under the next free number.
- **In order.** New slices wait in the git dir (`escapement-session-stage`), never in the root, until the operator has answered. Then slices and hook logs are moved in together through `adopt`, each under the next free number. Sessions go in order of their first timestamp, and within a session its hook logs come before its new slice, so a session's logs are numbered in the order they happened (#129). A slice's cursor moves only once the slice is in the root.
- **An unfinished earlier run.** When block A ran and block B didn't, the next block A clears what it left. A staged slice is removed. A slice left in the root by 4.10.0 is removed only while its bytes are still the transcript lines it was cut from. Anything else, such as a newer log that took its name, is left in place with a `left in place: …` warning, so it is never lost.
- **Asking.** Anything the gate can't decide (another branch, or work outside the session's worktree) is asked about once, listing each with its worktree, size, branches and time span. A declined slice is removed and its cursor stays put, so a later log picks it up. A declined hook log stays where it was.
- **Not archived:** subagent transcripts (the per-session subdirectories), and hook logs in a worktree that has been removed.

Each log's line in the archive README's Sessions table names the session and worktree it came from.

### In-Progress Format

During active work, raw JSONL session logs sit alongside your scratchpad:

```
your-project/
├── SESSION_LOG_1.jsonl    # Session start to first compaction
├── SESSION_LOG_2.jsonl    # First compaction to second
├── SCRATCHPAD_42.md       # Your scratchpad
└── ...
```

Incremental numbering ensures no overwrites.

### Conversion to Markdown

When you run the `archive-work` skill (typically after PR merge), it:

1. Saves the session tail since the last log as another `SESSION_LOG_{N}.jsonl`, and the unlogged part of every other session that worked on the issue (Phase 1.6)
2. Detects `SESSION_LOG_*.jsonl` files in the project root
3. Converts each with `scripts/convert-session-log.py` — metadata table, user/assistant sections, and tool use in `<details>` blocks
4. Writes `SESSION_LOG_{N}.md` to the archive directory
5. Deletes the `.jsonl` files from the project root

### Final Archive Location

When you use the `archive-work` skill after completing work, session logs are converted and moved:

**With context-path configured:**
```
{context-path}/
├── INDEX.md                          # Chronological archive manifest
└── {branch}/archive/
    ├── SCRATCHPAD_{issue_number}.md
    ├── SESSION_LOG_1.md              # Converted from JSONL
    ├── SESSION_LOG_2.md
    └── README.md
```

**Without context-path (in-repo):**
```
docs/dev/cc-archive/{YYYYMMDDHHMM}-{issue-number}-{description}/
├── SCRATCHPAD_{issue_number}.md
├── SESSION_LOG_1.md
└── README.md
```

## Configuration Options

### Hook Matcher

The hook is configured in `hooks/hooks.json` with matchers for both compaction types:

| Value | Description |
|-------|-------------|
| `"manual"` | Only manual /compact commands |
| `"auto"` | Only auto-compaction |

**Note:** Unlike other Claude Code hooks, PreCompact does NOT support `"*"` wildcard. To capture both auto and manual compaction, you must include **two separate matcher entries**. The default `hooks.json` includes both.

### Timeout

The `timeout` field (in seconds) controls how long to wait for the script to complete. Default: 60 seconds.

## Troubleshooting

### Session log not created

1. **Check script is executable:**
   ```bash
   ls -la /path/to/escapement/hooks/archive-session-log.sh
   ```
   Should show `-rwxr-xr-x` permissions.

2. **Check jq is installed:**
   ```bash
   which jq
   ```
   Install with: `sudo apt install jq` or `brew install jq`
   (jq is only used for parsing the 2-field hook input JSON — not for transcript processing.)

3. **Check hook configuration:**
   Verify the plugin is loaded and `hooks/hooks.json` has the correct configuration.

4. **Check trigger type:**
   Both `auto` and `manual` compaction should trigger the hook if both matchers are configured.

### Script errors

Run the script manually to test:

```bash
echo '{"transcript_path": "/path/to/test.jsonl", "session_id": "test", "trigger": "auto"}' | \
  CLAUDE_PROJECT_DIR=/path/to/project \
  /path/to/escapement/hooks/archive-session-log.sh
```

The script prints `Session log: FILE=… START=… END=… LINES=…` and a new `SESSION_LOG_{N}.jsonl` appears in the project directory, holding transcript lines START to END. Run it again without adding lines to the transcript and it prints `Session log: EMPTY`.

To test without moving your real cursors, set `XDG_STATE_HOME` to a scratch directory. The helper can also be run on its own:

```bash
XDG_STATE_HOME=/tmp/state /path/to/escapement/scripts/slice-session-log.sh \
  slice /path/to/test.jsonl /path/to/project
```

## Environment Variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `CLAUDE_PROJECT_DIR` | hook | Project directory; session logs are written here |
| `CLAUDE_CODE_SESSION_ID` | `archive-work` | Identifies the current session's transcript for the tail capture |
| `CLAUDE_CONFIG_DIR` | `archive-work` | Where Claude Code keeps transcripts (default `~/.claude`), for the tail and for finding other sessions |
| `XDG_STATE_HOME` | both | Where session cursors are kept (default `~/.local/state`) |

## Integration with Archive-Work

The `archive-work` skill handles the full lifecycle:

1. During active work, raw JSONL session logs accumulate in project root
2. When you invoke `archive-work`, it:
   - Saves the session tail since the last log (Phase 1.5)
   - Saves the other sessions that worked on the issue, and brings in their hook logs from other worktrees (Phase 1.6)
   - Converts `SESSION_LOG_*.jsonl` to markdown (Phase 3.5)
   - Moves converted `.md` files to the archive directory
   - Deletes `.jsonl` files from project root
   - Handles legacy `.md` session logs (from before this change) directly
3. Creates a README.md summarizing the archived work

## Dependencies

- **jq**: JSON processor (for parsing 2-field hook input only — not used for transcript processing)
- **bash**: Shell interpreter
- **grep, head, tail, wc**: For slicing the transcript (GNU or BSD/macOS versions)
- **git**: For detecting current branch (optional, graceful fallback)

## Security Notes

- The script only reads from the transcript path provided by Claude Code
- Writes only to your project directory, plus a small cursor file per session under `XDG_STATE_HOME`
- Never sends data externally
- Always exits 0 to avoid blocking your workflow
