---
name: create-issue
description: Create GitHub issues from natural language, designed for ad hoc idea capture mid-flow. Invoke when user says "create an issue", "file a bug", "open an issue to track", "add a feature request", or "create a ticket".
tools:
  - mcp__github__*
  - Bash:git *
  - Read
  - Grep
  - AskUserQuestion
---

# Create Issue Skill

## Purpose

Create GitHub issues directly from natural language prompts without leaving the coding session. This skill is designed for **ad hoc idea capture** - when a thought strikes mid-flow and needs to be filed before it's lost. The issue may relate to current work or be completely unrelated. The skill is lightweight and conversational, not ceremonial.

## Natural Language Triggers

This skill activates when the user says things like:
- "Create an issue for..."
- "File a bug about..."
- "Open an issue to track..."
- "Add a feature request for..."
- "Create a ticket for..."
- "We should track this as an issue"
- "Log this as a bug"
- Mid-work: "Oh, we should also file an issue about X"

## Workflow Execution

### Phase 1: Quick Context

Detect the target repository quickly without ceremony:

1. **Determine owner/repo:**
   ```bash
   git remote get-url origin
   ```
   Parse `owner/repo` from the remote URL (HTTPS or SSH format).

2. **Note current work context (opportunistic):**
   - Glance at `git branch --show-current` and any active scratchpad
   - This provides useful context if the new issue relates to current work
   - If it doesn't relate, ignore it - don't force a connection

This phase should be near-instant. Do not read CLAUDE.md or perform extensive context gathering unless the user's request specifically benefits from it (e.g., "file a bug about the archivist module" - then knowing module conventions helps).

### Phase 2: Refine Intent

**This is the core interaction.** The operator's initial prompt may be detailed or vague. Scale the questioning accordingly.

**If the prompt is already detailed** (has a clear title, describes the problem/feature, mentions specifics):
- Skip most clarifying questions
- Go directly to drafting with minimal confirmation

**If the prompt is vague** (e.g., "file a bug about login timeouts"):
- Ask targeted clarifying questions to flesh it out

Use `AskUserQuestion` to gather what's missing. Ask only what's needed - don't over-interrogate.

**Potential clarifying questions** (use judgment on which to ask):

1. **Title refinement:**
   ```
   AskUserQuestion:
     question: "Proposed title: '{inferred title}'. Does this capture it?"
     header: "Title"
     options:
       - label: "Yes, looks good"
         description: "Use this title as-is"
       - label: "Let me rephrase"
         description: "I'll provide a better title"
   ```

2. **Issue type** (if not obvious from phrasing):
   ```
   AskUserQuestion:
     question: "What kind of issue is this?"
     header: "Type"
     options:
       - label: "Bug"
         description: "Something is broken or behaving incorrectly"
       - label: "Feature"
         description: "New capability or enhancement"
       - label: "Task"
         description: "Work item, chore, or maintenance"
   ```

3. **More detail** (if the description would be too thin):
   ```
   AskUserQuestion:
     question: "Can you add more detail? For example: what's the expected vs actual behavior, or what the feature should do?"
     header: "Details"
     options:
       - label: "Let me describe more"
         description: "I'll provide additional context"
       - label: "Keep it brief"
         description: "The title says enough for now"
   ```

4. **Labels** (suggest based on issue type, only if repo uses labels):
   - Bug -> `bug` label
   - Feature -> `enhancement` label
   - Don't ask about labels if the issue is a quick capture - just apply the obvious one

**Key principle:** Treat this like a quick conversation, not a form to fill out. Two questions max for a simple issue. More only if the operator's idea genuinely needs fleshing out.

### Phase 3: Draft & Confirm

1. **Compose the issue:**

   **Title:** Clear, concise, imperative or descriptive

   **Body template** (adapt based on type):

   For bugs:
   ```markdown
   ## Summary
   {Description of the problem}

   ## Expected Behavior
   {What should happen}

   ## Actual Behavior
   {What happens instead}

   ## Context
   {Any relevant context - repo, module, version}
   ```

   For features/tasks:
   ```markdown
   ## Summary
   {What and why}

   ## Proposed Behavior
   {How it should work}

   ## Acceptance Criteria
   - [ ] {Criterion 1}
   - [ ] {Criterion 2}
   ```

   For quick captures (when user chose "keep it brief"):
   ```markdown
   {One or two sentences describing the idea}
   ```

2. **Preview and confirm:**

   Display the full issue draft, then:
   ```
   AskUserQuestion:
     question: "Create this issue?"
     header: "Confirm"
     options:
       - label: "Yes, create it"
         description: "Submit the issue to GitHub"
       - label: "Edit first"
         description: "I want to modify the title or body"
       - label: "Cancel"
         description: "Don't create the issue"
   ```

   If user chooses "Edit first":
   - Ask what to change (title, body, labels)
   - Apply edits
   - Show updated preview
   - Re-confirm

### Phase 4: Create & Report

1. **Create the issue:**
   ```
   mcp__github__create_issue(
     owner: "{owner}",
     repo: "{repo}",
     title: "{title}",
     body: "{body}",
     labels: ["{labels}"]
   )
   ```

2. **Report result:**
   ```
   Issue created!

   #{number}: {title}
   {issue URL}

   Labels: {labels}
   ```

3. **Offer next step** (only if it makes sense):
   ```
   AskUserQuestion:
     question: "Want to start working on this issue now?"
     header: "Next"
     options:
       - label: "Yes, set up work"
         description: "Run setup-work to create scratchpad and branch"
       - label: "No, back to what I was doing"
         description: "Return to current work"
   ```

   If user chooses to set up work, invoke:
   ```
   Skill: setup-work
   args: "{issue_number}"
   ```

   **Note:** Most of the time the user filed this ad hoc and wants to get back to their current task. Default expectation is "No, back to what I was doing."

## Context Awareness (Opportunistic)

The skill **can** read the project's CLAUDE.md for enrichment but **doesn't require it**:

- **Module names:** If the user mentions a module by name ("file a bug about archivist"), and CLAUDE.md defines module conventions, use them for labels or body context.
- **Label conventions:** If the project has specific label schemes, apply them.
- **Issue templates:** If the project uses structured issue templates, follow them.

This is opportunistic - the skill works perfectly well without any of this. Don't slow down the interaction to read configuration files unless the user's request clearly benefits.

## Error Handling

### Repository Not Detected
```
Could not detect repository from git remote.

Are you in a git repository? Specify the target:
  owner/repo (e.g., "fusupo/escapement")
```

### Issue Creation Failed
```
Failed to create issue: {error message}

This might be a permissions issue. Check:
- GitHub authentication: gh auth status
- Repository access: do you have write access?
```

### No Title Provided
If the user's prompt is too vague to extract even a rough title:
```
AskUserQuestion:
  question: "What should the issue title be?"
  header: "Title"
  options:
    - label: "Let me type it"
      description: "I'll provide the title"
```

## Integration with Other Skills

**Chains to:**
- `setup-work` - If user wants to immediately work on the new issue

**Independent of:**
- All other skills - This is an ad hoc tool, not part of the sequential workflow

**Can be used during:**
- `do-work` sessions - Mid-implementation idea capture
- Any coding session - Standalone issue creation

## Best Practices

### DO:
- Keep the interaction fast and lightweight
- Scale questions to prompt vagueness (detailed prompt = fewer questions)
- Apply obvious labels without asking (bug -> `bug`)
- Offer setup-work chaining but don't push it
- Get back to the user's previous context quickly after filing

### DON'T:
- Over-interrogate - this is idea capture, not a planning session
- Require reading CLAUDE.md before proceeding
- Add excessive structure to quick captures
- Assume the issue relates to current work
- Block on label selection or assignee choices for simple issues

---

**Version:** 1.0.0
**Last Updated:** 2026-02-18
**Maintained By:** Escapement
