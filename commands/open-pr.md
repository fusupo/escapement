allowed-tools: GitHub(*), Linear(*), Bash(git log --oneline), Bash(git log:*), Bash(git diff:*), Bash(git branch:*), Bash(gh pr create:*)
description: Create a context-aware pull request with issue integration and appropriate scope
---

## Analysis Required

First, gather the following information using Claude's tools:

1. **Project Context**: Read PROJECT_CONTEXT.md or CLAUDE.md for current development approach
2. **Branch Analysis**: 
   - Get current branch name
   - List commits since target branch (default: develop-ts)
   - Show change summary
3. **Issue Context**: Extract issue reference from branch name and retrieve details

### **Issue Detection & Retrieval**
1. **Extract issue reference** from branch name (patterns: `ABC-123-*`, `feature/123-*`, `fix/456-*`)
2. **Retrieve issue details**:
   - If Linear issue detected: Use Linear tools to get issue details, description, acceptance criteria
   - If GitHub issue detected: Use GitHub tools to get issue details
   - Include issue context in PR creation for alignment verification

## Your Task
Create a pull request that aligns with the original issue requirements, project goals, and incremental development philosophy:

### **PR Title**
Generate based on issue title and primary capability delivered (reference issue number)

### **PR Description Template:**
```markdown
## Summary
{Brief explanation aligned with original issue goals and project context}

## Issue Resolution
Closes #{issue_number}
{How the implementation addresses the original issue requirements}

## Key Changes
- {Module-focused change descriptions}
- {Breaking changes or integration points}
- {New capabilities enabled}

## Project Progress
{How this advances toward project goals}

## Implementation Notes
{Any deviations from issue description or additional considerations}

## Testing Approach
{Current testing status appropriate for project phase}
```

### **Auto-Configuration:**
- **Labels**: Detect from issue labels + modules affected + change types
- **Target**: Default to project's main integration branch (check CLAUDE.md or use main/develop)
- **Draft Status**: Set draft if branch contains "wip", "draft", or issue is incomplete
- **Reviewers**: Suggest based on issue assignees and module ownership
- **Issue Linking**: Auto-close referenced issue when PR merges

### **Issue-Aware Suggestions:**
- Verify implementation **matches issue acceptance criteria**
- Suggest **issue-relevant testing** appropriate for current development phase
- Focus on **completing the stated requirements** rather than scope expansion
- Note any **requirement deviations** or **additional work** needed

Create the PR with full context from the originating issue and current project maturity.
