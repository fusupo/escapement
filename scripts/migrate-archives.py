#!/usr/bin/env python3
"""Migrate in-repo archives to context-path directory structure.

Scans docs/dev/cc-archive/ for archived development work and copies it
into the context-path structure used by Escapement's archive-work skill,
backfilling INDEX.md with entries for each migrated archive.

Usage:
    python3 migrate-archives.py [--dry-run] [--source DIR] [--context-path DIR]

Examples:
    # Auto-detect context-path from CLAUDE.md, default source
    python3 scripts/migrate-archives.py --dry-run

    # Explicit paths
    python3 scripts/migrate-archives.py --source docs/dev/cc-archive/ --context-path ../project-ctx/
"""

import argparse
import re
import shutil
import sys
from pathlib import Path

TIMESTAMP_PREFIX_RE = re.compile(r"^\d{12}-")
ARCHIVED_DATE_RE = re.compile(r"\*\*Archived:\*\*\s*(\d{4}-\d{2}-\d{2})")
PR_NUMBER_RE = re.compile(r"\*\*PR:\*\*\s*#?(\d+)")
PR_URL_RE = re.compile(r"pull/(\d+)")
STATUS_RE = re.compile(r"\*\*Status:\*\*\s*(.+?)$", re.MULTILINE)
TITLE_RE = re.compile(r"^# (.+)$", re.MULTILINE)
GITHUB_URL_RE = re.compile(r"\*\*GitHub URL:\*\*\s*(https://github\.com/\S+)")
ISSUE_NUMBER_FROM_URL_RE = re.compile(r"/issues/(\d+)")
SCRATCHPAD_TITLE_RE = re.compile(r"^# (.+?) - #\d+$", re.MULTILINE)
CONTEXT_PATH_RE = re.compile(
    r"^\s*-\s*\*\*context-path\*\*:\s*(\S+)", re.MULTILINE
)

INDEX_HEADER = """# Archive Index

| Archived | Branch | Issue | Status |
|----------|--------|-------|--------|
"""
INDEX_SEPARATOR = "|----------|--------|-------|--------|"

STATUS_NORMALIZE = {
    "completed/merged": "Merged",
    "completed and merged": "Merged",
    "merged": "Merged",
    "completed": "Completed",
}


def detect_context_path(project_root):
    """Read context-path from project's CLAUDE.md.

    Uses the last match to avoid hitting examples inside code blocks.
    """
    claude_md = project_root / "CLAUDE.md"
    if not claude_md.exists():
        return None
    text = claude_md.read_text()
    matches = CONTEXT_PATH_RE.findall(text)
    if matches:
        return (project_root / matches[-1]).resolve()
    return None


def derive_branch_name(dirname):
    """Strip YYYYMMDDHHMM- timestamp prefix if present."""
    return TIMESTAMP_PREFIX_RE.sub("", dirname)


def parse_timestamp_prefix(dirname):
    """Extract date from YYYYMMDDHHMM- prefix, if present."""
    match = re.match(r"^(\d{4})(\d{2})(\d{2})\d{4}-", dirname)
    if match:
        return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
    return None


def normalize_status(raw):
    """Normalize status string to canonical form."""
    if raw is None:
        return "Completed"
    return STATUS_NORMALIZE.get(raw.strip().lower(), raw.strip())


def parse_readme(readme_path):
    """Extract metadata from an archive README.md."""
    text = readme_path.read_text()

    title_m = TITLE_RE.search(text)
    archived_m = ARCHIVED_DATE_RE.search(text)
    pr_m = PR_NUMBER_RE.search(text)
    if not pr_m:
        pr_m = PR_URL_RE.search(text)
    status_m = STATUS_RE.search(text)

    return {
        "title": title_m.group(1).strip() if title_m else None,
        "archived_date": archived_m.group(1) if archived_m else None,
        "pr_number": pr_m.group(1) if pr_m else None,
        "status": normalize_status(status_m.group(1) if status_m else None),
    }


def parse_scratchpad(archive_dir):
    """Find SCRATCHPAD file and extract issue URL/number."""
    candidates = sorted(archive_dir.glob("SCRATCHPAD_*.md")) + sorted(
        archive_dir.glob("SCRATCHPAD.md")
    )
    if not candidates:
        return {"issue_url": None, "issue_number": None, "issue_title": None}

    text = candidates[0].read_text()

    url_match = GITHUB_URL_RE.search(text)
    issue_url = url_match.group(1) if url_match else None

    issue_number = None
    if issue_url:
        num_match = ISSUE_NUMBER_FROM_URL_RE.search(issue_url)
        issue_number = num_match.group(1) if num_match else None

    title_match = SCRATCHPAD_TITLE_RE.search(text)
    issue_title = title_match.group(1).strip() if title_match else None

    return {
        "issue_url": issue_url,
        "issue_number": issue_number,
        "issue_title": issue_title,
    }


def scan_archives(source_dir):
    """Scan source directory and collect metadata for each archive."""
    archives = []
    warnings = []

    for entry in sorted(source_dir.iterdir()):
        if not entry.is_dir():
            continue

        dirname = entry.name
        branch = derive_branch_name(dirname)

        # Parse README
        readme_path = entry / "README.md"
        if readme_path.exists():
            readme_meta = parse_readme(readme_path)
        else:
            readme_meta = {
                "title": None,
                "archived_date": None,
                "pr_number": None,
                "status": "Completed",
            }
            warnings.append((dirname, "No README.md found"))

        # Parse scratchpad
        scratchpad_meta = parse_scratchpad(entry)

        # Date fallback: README > timestamp prefix > unknown
        archived_date = readme_meta["archived_date"]
        if not archived_date:
            archived_date = parse_timestamp_prefix(dirname)
        if not archived_date:
            archived_date = "unknown"
            warnings.append((dirname, "Could not determine archived date"))

        # Title: README title preferred, then scratchpad title, then branch
        title = (
            readme_meta["title"] or scratchpad_meta["issue_title"] or branch
        )

        # Warnings for missing data
        if not scratchpad_meta["issue_url"]:
            warnings.append((dirname, "No GitHub URL found in scratchpad"))

        archives.append(
            {
                "source_dir": entry,
                "dirname": dirname,
                "branch": branch,
                "archived_date": archived_date,
                "title": title,
                "pr_number": readme_meta["pr_number"],
                "status": readme_meta["status"],
                "issue_url": scratchpad_meta["issue_url"],
                "issue_number": scratchpad_meta["issue_number"],
            }
        )

    return archives, warnings


def migrate_archive(archive_meta, context_path, dry_run=False):
    """Copy archive contents to context-path structure.

    Returns (dest_dir, files_copied, skipped).
    """
    branch = archive_meta["branch"]
    dest_dir = context_path / branch / "archive"

    if dest_dir.exists():
        return dest_dir, [], True

    files_copied = []
    for src_file in sorted(archive_meta["source_dir"].iterdir()):
        if src_file.is_file():
            dest_file = dest_dir / src_file.name
            if not dry_run:
                dest_dir.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src_file, dest_file)
            files_copied.append(src_file.name)

    return dest_dir, files_copied, False


def build_index_row(meta):
    """Build a single INDEX.md table row."""
    date = meta["archived_date"]
    branch = meta["branch"]
    status = meta["status"]

    if meta["issue_url"] and meta["issue_number"]:
        issue_cell = f"[#{meta['issue_number']}]({meta['issue_url']}) {meta['title']}"
    else:
        issue_cell = meta["title"]

    return f"| {date} | {branch} | {issue_cell} | {status} |"


def update_index(index_path, archive_metas, dry_run=False):
    """Update INDEX.md with new entries, merging with existing rows.

    Returns (new_content, rows_added).
    """
    if index_path.exists():
        content = index_path.read_text()
    else:
        content = INDEX_HEADER

    # Detect already-present branches
    existing_branches = set(
        re.findall(r"^\| \S+ \| (\S+) \|", content, re.MULTILINE)
    )

    # Filter to only new entries
    new_metas = [m for m in archive_metas if m["branch"] not in existing_branches]

    if not new_metas:
        return content, 0

    # Sort by archived_date descending (newest first), unknowns last
    def sort_key(m):
        d = m["archived_date"]
        return "0000-00-00" if d == "unknown" else d

    new_metas.sort(key=sort_key, reverse=True)

    row_lines = "\n".join(build_index_row(m) for m in new_metas)
    new_content = content.replace(
        INDEX_SEPARATOR, INDEX_SEPARATOR + "\n" + row_lines, 1
    )

    if not dry_run:
        index_path.parent.mkdir(parents=True, exist_ok=True)
        index_path.write_text(new_content)

    return new_content, len(new_metas)


def print_report(results, warnings, index_rows_added, index_path, dry_run):
    """Print migration summary report."""
    migrated = sum(1 for _, _, skipped in results if not skipped)
    skipped = sum(1 for _, _, s in results if s)

    mode = " (dry-run)" if dry_run else ""
    print(f"\nMigration complete{mode}")
    print("=" * 40)
    print(f"  Migrated:  {migrated} archives")
    print(f"  Skipped:   {skipped} (already migrated)")
    print(f"  Warnings:  {len(warnings)}")
    print(f"  INDEX.md:  {index_rows_added} rows added -> {index_path}")

    if warnings:
        print(f"\nWarnings:")
        for dirname, msg in warnings:
            print(f"  [WARN] {dirname}: {msg}")


def main():
    parser = argparse.ArgumentParser(
        description="Migrate in-repo archives to context-path structure."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without writing files",
    )
    parser.add_argument(
        "--source",
        type=Path,
        help="Source archive directory (default: docs/dev/cc-archive/)",
    )
    parser.add_argument(
        "--context-path",
        type=Path,
        help="Target context-path directory (default: auto-detect from CLAUDE.md)",
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path.cwd(),
        help="Project root directory (default: current directory)",
    )
    args = parser.parse_args()

    project_root = args.project_root.resolve()

    # Resolve source directory
    source_dir = args.source or (project_root / "docs" / "dev" / "cc-archive")
    source_dir = source_dir.resolve()
    if not source_dir.is_dir():
        print(f"Error: Source directory not found: {source_dir}", file=sys.stderr)
        sys.exit(1)

    # Resolve context-path
    context_path = args.context_path
    if context_path is None:
        context_path = detect_context_path(project_root)
        if context_path is None:
            print(
                "Error: No context-path found in CLAUDE.md. "
                "Use --context-path to specify explicitly.",
                file=sys.stderr,
            )
            sys.exit(1)
    context_path = context_path.resolve()
    if not context_path.is_dir():
        print(
            f"Error: Context-path directory not found: {context_path}",
            file=sys.stderr,
        )
        sys.exit(1)

    mode = "DRY RUN" if args.dry_run else "LIVE"
    print(f"Archive Migration ({mode})")
    print(f"  Source:       {source_dir}")
    print(f"  Context-path: {context_path}")
    print()

    # Phase 1: Scan and collect metadata
    archives, warnings = scan_archives(source_dir)
    if not archives:
        print("No archive directories found in source.")
        sys.exit(0)

    # Phase 2: Migrate each archive
    results = []
    for meta in archives:
        dest_dir, files_copied, skipped = migrate_archive(
            meta, context_path, dry_run=args.dry_run
        )

        if skipped:
            print(f"[SKIP] {meta['dirname']} (already migrated)")
        else:
            print(f"[MIGRATE] {meta['dirname']}")
            print(f"  Branch: {meta['branch']}")
            print(f"  Dest:   {dest_dir}")
            print(f"  Files:  {', '.join(files_copied)}")
            print(f"  Date:   {meta['archived_date']}")
            if meta["issue_url"]:
                print(f"  Issue:  #{meta['issue_number']} {meta['issue_url']}")
            print(f"  Status: {meta['status']}")

        results.append((dest_dir, files_copied, skipped))

    # Phase 3: Update INDEX.md
    index_path = context_path / "INDEX.md"
    migrated_metas = [
        meta
        for meta, (_, _, skipped) in zip(archives, results)
        if not skipped
    ]
    _, index_rows_added = update_index(
        index_path, migrated_metas, dry_run=args.dry_run
    )

    # Phase 4: Summary
    print_report(results, warnings, index_rows_added, index_path, args.dry_run)


if __name__ == "__main__":
    main()
