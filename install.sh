#!/bin/bash
# Install Muleteer Claude Code workflow into ~/.claude/

set -e  # Exit on error

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "🔧 Installing Muleteer workflow..."

# Create ~/.claude structure if it doesn't exist
mkdir -p ~/.claude/{commands,agents,skills}

# Symlink skills
echo "📚 Installing skills..."
if [ -d "$SCRIPT_DIR/skills" ]; then
    for skill_dir in "$SCRIPT_DIR"/skills/*/; do
        skill_name=$(basename "$skill_dir")
        target=~/.claude/skills/"$skill_name"

        # Remove existing symlink/directory if it exists
        if [ -L "$target" ] || [ -d "$target" ]; then
            rm -rf "$target"
        fi

        ln -s "$skill_dir" "$target"
        echo "  ✓ Linked skill: $skill_name"
    done
fi

# Symlink commands
echo "⚡ Installing commands..."
if [ -d "$SCRIPT_DIR/commands" ]; then
    for cmd in "$SCRIPT_DIR"/commands/*.md; do
        if [ -f "$cmd" ]; then
            cmd_name=$(basename "$cmd")
            target=~/.claude/commands/"$cmd_name"

            # Remove existing symlink if it exists
            [ -L "$target" ] && rm "$target"

            ln -sf "$cmd" "$target"
            echo "  ✓ Linked command: $cmd_name"
        fi
    done
fi

# Symlink agents
echo "🤖 Installing agents..."
if [ -d "$SCRIPT_DIR/agents" ]; then
    for agent in "$SCRIPT_DIR"/agents/*.md; do
        if [ -f "$agent" ]; then
            agent_name=$(basename "$agent")
            target=~/.claude/agents/"$agent_name"

            # Remove existing symlink if it exists
            [ -L "$target" ] && rm "$target"

            ln -sf "$agent" "$target"
            echo "  ✓ Linked agent: $agent_name"
        fi
    done
fi

# Handle CLAUDE.md
echo "📝 Installing Muleteer context..."
if [ -f "$SCRIPT_DIR/CLAUDE-MULETEER.md" ]; then
    # If ~/.claude/CLAUDE.md doesn't exist, create it
    if [ ! -f ~/.claude/CLAUDE.md ]; then
        touch ~/.claude/CLAUDE.md
        echo "# Claude Configuration" > ~/.claude/CLAUDE.md
        echo "" >> ~/.claude/CLAUDE.md
    fi

    # Check if Muleteer context is already included
    if ! grep -q "## Muleteer Workflow Context" ~/.claude/CLAUDE.md 2>/dev/null; then
        echo "" >> ~/.claude/CLAUDE.md
        cat "$SCRIPT_DIR/CLAUDE-MULETEER.md" >> ~/.claude/CLAUDE.md
        echo "  ✓ Appended Muleteer context to CLAUDE.md"
    else
        echo "  ℹ Muleteer context already in CLAUDE.md (skipped)"
    fi
fi

echo ""
echo "✅ Muleteer workflow installed successfully!"
echo ""
echo "📋 Available skills:"
[ -d "$SCRIPT_DIR/skills" ] && ls -1 "$SCRIPT_DIR"/skills/ | sed 's/^/   - /'
echo ""
echo "⚡ Available commands:"
[ -d "$SCRIPT_DIR/commands" ] && ls -1 "$SCRIPT_DIR"/commands/*.md | xargs -n1 basename | sed 's/.md$//' | sed 's/^/   - \//'
echo ""
echo "🤖 Available agents:"
[ -d "$SCRIPT_DIR/agents" ] && ls -1 "$SCRIPT_DIR"/agents/*.md 2>/dev/null | xargs -n1 basename | sed 's/.md$//' | sed 's/^/   - /' || echo "   (none yet - extensibility ready)"
echo ""
echo "🚀 Start using: Open Claude Code in any project repo"
