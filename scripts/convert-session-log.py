#!/usr/bin/env python3
"""Convert a JSONL session transcript to readable markdown.

Usage:
    python3 convert-session-log.py INPUT.jsonl OUTPUT.md [CODE_SHA]

Used by the archive-work skill (Phase 3.5) to convert raw session
transcripts captured by the PreCompact hook into archived markdown.
"""

import json
import re
import sys


def extract_text_from_content(content):
    """Extract text from a message content field (string or array)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
        return "\n\n".join(parts)
    return str(content)


def clean_user_text(text):
    """Strip system-injected tags from user messages."""
    text = re.sub(r"<system-reminder>.*?</system-reminder>", "", text, flags=re.DOTALL)
    text = re.sub(
        r"<local-command-caveat>.*?</local-command-caveat>", "", text, flags=re.DOTALL
    )
    text = re.sub(
        r"<local-command-stdout>.*?</local-command-stdout>", "", text, flags=re.DOTALL
    )
    text = re.sub(
        r"<command-name>.*?</command-name>\s*<command-message>.*?</command-message>\s*<command-args>.*?</command-args>",
        "",
        text,
        flags=re.DOTALL,
    )
    return text.strip()


def truncate_lines(text, max_lines=100):
    """Truncate text to max_lines, adding a note if truncated."""
    lines = text.split("\n")
    if len(lines) > max_lines:
        return "\n".join(lines[:max_lines]) + f"\n\n*[truncated — {len(lines) - max_lines} more lines]*"
    return text


def format_tool_use(item):
    """Format a tool_use content block as a collapsible details element."""
    tool_name = item.get("name", "unknown")
    tool_input = json.dumps(item.get("input", {}), indent=2)
    tool_input = truncate_lines(tool_input)
    return f"\n<details><summary>Tool: {tool_name}</summary>\n\n```json\n{tool_input}\n```\n</details>\n"


def convert(input_path, output_path, code_sha="unknown"):
    entries = []
    with open(input_path, "r") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue

    # Extract metadata from first user/assistant entry
    session_id = git_branch = timestamp = ""
    for entry in entries:
        if entry.get("type") in ("user", "assistant"):
            session_id = entry.get("sessionId", "")
            git_branch = entry.get("gitBranch", "")
            timestamp = entry.get("timestamp", "")
            break

    out = []
    out.append("# Session Log\n")
    out.append("## Metadata\n")
    out.append("| Field | Value |")
    out.append("|-------|-------|")
    out.append(f"| Session ID | {session_id} |")
    out.append(f"| Branch | {git_branch} |")
    out.append(f"| Timestamp | {timestamp} |")
    out.append(f"| Code SHA | {code_sha} |")
    out.append("")
    out.append("---\n")
    out.append("## Conversation\n")

    for entry in entries:
        msg_type = entry.get("type", "")

        if msg_type == "user":
            if entry.get("isMeta"):
                continue
            message = entry.get("message", {})
            text = extract_text_from_content(message.get("content", ""))
            text = clean_user_text(text)
            if not text:
                continue
            text = truncate_lines(text)
            out.append("### User\n")
            out.append(text)
            out.append("")

        elif msg_type == "assistant":
            message = entry.get("message", {})
            content = message.get("content", "")
            parts = []
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict):
                        if item.get("type") == "text":
                            parts.append(item.get("text", ""))
                        elif item.get("type") == "tool_use":
                            parts.append(format_tool_use(item))
                        # Skip thinking blocks
            else:
                parts.append(str(content))
            text = "\n\n".join(parts)
            if not text.strip():
                continue
            out.append("### Assistant\n")
            out.append(text)
            out.append("")

        elif msg_type == "summary":
            summary = entry.get("summary", "") or entry.get("message", {}).get(
                "content", ""
            )
            if summary:
                out.append("### Summary (Previous Compaction)\n")
                out.append(str(summary))
                out.append("")

        # Skip: progress, system, file-history-snapshot, pr-link, other

    out.append("---\n")
    out.append("*Session log converted by Escapement archive-work skill*")

    with open(output_path, "w") as f:
        f.write("\n".join(out) + "\n")

    print(f"Converted {len(entries)} entries -> {output_path}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} INPUT.jsonl OUTPUT.md [CODE_SHA]", file=sys.stderr)
        sys.exit(1)

    sha = sys.argv[3] if len(sys.argv) > 3 else "unknown"
    convert(sys.argv[1], sys.argv[2], sha)
