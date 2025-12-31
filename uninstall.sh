#!/bin/bash
# Uninstall Muleteer Claude Code workflow from ~/.claude/

set -e  # Exit on error

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Default options
DRY_RUN=false
FORCE=false
CLEANUP_EMPTY=false

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Track what was removed
REMOVED_SKILLS=()
REMOVED_AGENTS=()
REMOVED_CLAUDE_MD=false
REMOVED_HOOK=false

usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Uninstall Muleteer Claude Code workflow from ~/.claude/"
    echo ""
    echo "Options:"
    echo "  -n, --dry-run     Preview what would be removed without making changes"
    echo "  -f, --force       Skip confirmation prompt"
    echo "  -c, --cleanup     Remove empty skills/agents directories after cleanup"
    echo "  -h, --help        Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                    # Interactive uninstall with confirmation"
    echo "  $0 --dry-run          # Preview what would be removed"
    echo "  $0 --force            # Uninstall without confirmation"
    echo "  $0 --force --cleanup  # Uninstall and clean up empty directories"
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -n|--dry-run)
            DRY_RUN=true
            shift
            ;;
        -f|--force)
            FORCE=true
            shift
            ;;
        -c|--cleanup)
            CLEANUP_EMPTY=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
done

# Check if a symlink points to Muleteer
is_muleteer_symlink() {
    local link="$1"
    if [ -L "$link" ]; then
        local target
        target=$(readlink -f "$link" 2>/dev/null || readlink "$link")
        if echo "$target" | grep -q "muleteer"; then
            return 0
        fi
    fi
    return 1
}

# Remove Muleteer skill symlinks
remove_skill_symlinks() {
    local skills_dir=~/.claude/skills

    if [ ! -d "$skills_dir" ]; then
        echo "  No skills directory found"
        return
    fi

    for skill in "$skills_dir"/*; do
        if [ -e "$skill" ] && is_muleteer_symlink "$skill"; then
            local skill_name=$(basename "$skill")
            if [ "$DRY_RUN" = true ]; then
                echo -e "  ${YELLOW}Would remove skill:${NC} $skill_name"
            else
                rm -rf "$skill"
                echo -e "  ${GREEN}Removed skill:${NC} $skill_name"
            fi
            REMOVED_SKILLS+=("$skill_name")
        fi
    done

    if [ ${#REMOVED_SKILLS[@]} -eq 0 ]; then
        echo "  No Muleteer skills found"
    fi
}

# Remove Muleteer agent symlinks
remove_agent_symlinks() {
    local agents_dir=~/.claude/agents

    if [ ! -d "$agents_dir" ]; then
        echo "  No agents directory found"
        return
    fi

    for agent in "$agents_dir"/*; do
        if [ -e "$agent" ] && is_muleteer_symlink "$agent"; then
            local agent_name=$(basename "$agent")
            if [ "$DRY_RUN" = true ]; then
                echo -e "  ${YELLOW}Would remove agent:${NC} $agent_name"
            else
                rm -f "$agent"
                echo -e "  ${GREEN}Removed agent:${NC} $agent_name"
            fi
            REMOVED_AGENTS+=("$agent_name")
        fi
    done

    if [ ${#REMOVED_AGENTS[@]} -eq 0 ]; then
        echo "  No Muleteer agents found"
    fi
}

# Remove Muleteer section from CLAUDE.md
remove_claude_md_section() {
    local claude_md=~/.claude/CLAUDE.md

    if [ ! -f "$claude_md" ]; then
        echo "  No CLAUDE.md found"
        return
    fi

    # Check if Muleteer section exists
    if ! grep -q "^## Muleteer Workflow Context$" "$claude_md" 2>/dev/null; then
        echo "  No Muleteer section found in CLAUDE.md"
        return
    fi

    if [ "$DRY_RUN" = true ]; then
        echo -e "  ${YELLOW}Would remove Muleteer section from CLAUDE.md${NC}"
        REMOVED_CLAUDE_MD=true
        return
    fi

    # Create a backup
    cp "$claude_md" "$claude_md.bak"

    # Remove the Muleteer section
    # The section starts with "## Muleteer Workflow Context" and ends with
    # "*This is the base Muleteer workflow context.*" followed by blank lines
    # Use awk for more reliable multi-line removal
    awk '
        /^## Muleteer Workflow Context$/ { skip=1 }
        skip && /^\*This is the base Muleteer workflow context/ {
            skip=0
            next
        }
        !skip { print }
    ' "$claude_md.bak" > "$claude_md"

    # Clean up any trailing blank lines at the section boundary
    # Remove the backup if successful
    rm "$claude_md.bak"

    echo -e "  ${GREEN}Removed Muleteer section from CLAUDE.md${NC}"
    REMOVED_CLAUDE_MD=true
}

# Remove PreCompact hook from settings.json
remove_precompact_hook() {
    local settings_file=~/.claude/settings.json

    if [ ! -f "$settings_file" ]; then
        echo "  No settings.json found"
        return
    fi

    # Check if jq is available
    if ! command -v jq &> /dev/null; then
        echo -e "  ${YELLOW}Warning: jq not found, cannot remove hook automatically${NC}"
        echo "  Please manually remove the PreCompact hook from ~/.claude/settings.json"
        return
    fi

    # Check if PreCompact hook exists and contains muleteer reference
    if ! jq -e '.hooks.PreCompact' "$settings_file" > /dev/null 2>&1; then
        echo "  No PreCompact hook found"
        return
    fi

    # Check if the hook is Muleteer's (contains muleteer in command)
    if ! jq -r '.hooks.PreCompact | .. | .command? // empty' "$settings_file" 2>/dev/null | grep -q "muleteer"; then
        echo "  PreCompact hook exists but is not Muleteer's"
        return
    fi

    if [ "$DRY_RUN" = true ]; then
        echo -e "  ${YELLOW}Would remove PreCompact hook from settings.json${NC}"
        REMOVED_HOOK=true
        return
    fi

    # Remove the PreCompact hook
    jq 'del(.hooks.PreCompact)' "$settings_file" > "$settings_file.tmp" && \
        mv "$settings_file.tmp" "$settings_file"

    # If hooks object is now empty, remove it too
    if jq -e '.hooks == {}' "$settings_file" > /dev/null 2>&1; then
        jq 'del(.hooks)' "$settings_file" > "$settings_file.tmp" && \
            mv "$settings_file.tmp" "$settings_file"
    fi

    echo -e "  ${GREEN}Removed PreCompact hook from settings.json${NC}"
    REMOVED_HOOK=true
}

# Clean up empty directories
cleanup_empty_dirs() {
    if [ "$CLEANUP_EMPTY" != true ]; then
        return
    fi

    echo ""
    echo "Cleaning up empty directories..."

    for dir in ~/.claude/skills ~/.claude/agents; do
        if [ -d "$dir" ] && [ -z "$(ls -A "$dir")" ]; then
            if [ "$DRY_RUN" = true ]; then
                echo -e "  ${YELLOW}Would remove empty directory:${NC} $dir"
            else
                rmdir "$dir"
                echo -e "  ${GREEN}Removed empty directory:${NC} $dir"
            fi
        fi
    done
}

# Print summary
print_summary() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if [ "$DRY_RUN" = true ]; then
        echo -e "${YELLOW}DRY RUN SUMMARY - No changes made${NC}"
    else
        echo -e "${GREEN}UNINSTALL SUMMARY${NC}"
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Skills removed: ${#REMOVED_SKILLS[@]}"
    for skill in "${REMOVED_SKILLS[@]}"; do
        echo "  - $skill"
    done
    echo ""
    echo "Agents removed: ${#REMOVED_AGENTS[@]}"
    for agent in "${REMOVED_AGENTS[@]}"; do
        echo "  - $agent"
    done
    echo ""
    echo "CLAUDE.md section: $([ "$REMOVED_CLAUDE_MD" = true ] && echo "removed" || echo "not found")"
    echo "PreCompact hook: $([ "$REMOVED_HOOK" = true ] && echo "removed" || echo "not found")"
    echo ""

    if [ "$DRY_RUN" = true ]; then
        echo "Run without --dry-run to apply these changes."
    else
        echo "Muleteer has been uninstalled."
        echo ""
        echo "Note: The ~/.muleteer directory was not removed."
        echo "To completely remove Muleteer, run: rm -rf ~/.muleteer"
    fi
}

# Main execution
main() {
    if [ "$DRY_RUN" = true ]; then
        echo -e "${YELLOW}DRY RUN MODE - No changes will be made${NC}"
        echo ""
    fi

    echo "Uninstalling Muleteer workflow..."
    echo ""

    # Confirmation prompt (unless --force or --dry-run)
    if [ "$FORCE" != true ] && [ "$DRY_RUN" != true ]; then
        echo "This will remove:"
        echo "  - Muleteer skill symlinks from ~/.claude/skills/"
        echo "  - Muleteer agent symlinks from ~/.claude/agents/"
        echo "  - Muleteer section from ~/.claude/CLAUDE.md"
        echo "  - PreCompact hook from ~/.claude/settings.json"
        echo ""
        read -p "Continue? [y/N] " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Uninstall cancelled."
            exit 0
        fi
        echo ""
    fi

    echo "Removing skill symlinks..."
    remove_skill_symlinks

    echo ""
    echo "Removing agent symlinks..."
    remove_agent_symlinks

    echo ""
    echo "Removing CLAUDE.md section..."
    remove_claude_md_section

    echo ""
    echo "Removing PreCompact hook..."
    remove_precompact_hook

    cleanup_empty_dirs

    print_summary
}

main
