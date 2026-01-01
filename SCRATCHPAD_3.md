# Integrate Claude Code Affordances Throughout Workflow - #3

## Issue Details
- **Repository:** fusupo/muleteer
- **GitHub URL:** https://github.com/fusupo/muleteer/issues/3
- **State:** open
- **Labels:** enhancement
- **Related Issues:**
  - Depends on: #1 (skills must exist - COMPLETED)
  - Enables: Better UX for all workflow stages

## Description

Integrate Claude Code's native capabilities into Muleteer skills for a more powerful, responsive workflow:
- TodoWrite for live progress tracking
- Task tool for delegating to specialized agents
- Parallel tool calls for performance
- EnterPlanMode for complex implementations
- AskUserQuestion for interactive decisions
- LSP for code intelligence

## Current State Analysis

| Affordance | work-session | issue-setup | commit-changes | create-pr | review-pr | archive-work | prime-session |
|------------|--------------|-------------|----------------|-----------|-----------|--------------|---------------|
| TodoWrite | Already docs | - | In tools | - | - | - | - |
| Task | - | - | - | - | In tools | - | - |
| Parallel | - | - | Mentioned | Mentioned | Mentioned | - | - |
| EnterPlanMode | - | - | - | - | - | - | - |
| AskUserQuestion | Used | Used | Used | Used | - | Used | - |
| LSP | - | - | - | - | - | - | - |

## Acceptance Criteria

- [x] TodoWrite used in work-session skill for task tracking (already documented)
- [x] Task tool delegates complex analysis to specialized agents (issue-setup, work-session)
- [x] Parallel tool calls improve workflow performance (issue-setup, archive-work)
- [x] EnterPlanMode triggered for complex implementations (issue-setup, work-session)
- [x] AskUserQuestion used for key decision points (review-pr, prime-session)
- [x] LSP integration for code navigation (issue-setup, work-session)
- [x] User experience is more responsive and intelligent

## Branch Strategy
- **Base branch:** main
- **Feature branch:** 3-integrate-claude-code-affordances
- **Current branch:** main

## Implementation Checklist

### Setup
- [x] Fetch latest from base branch
- [x] Create feature branch

### Implementation Tasks

#### 1. Enhance issue-setup with Task Delegation & Parallel Execution
- [x] Add Task tool to frontmatter tools list
- [x] Phase 2 (Analyze & Plan): Delegate codebase investigation to Explore agent
- [x] Phase 1 (Fetch): Make operations parallel
- [x] Add LSP tool for code navigation during analysis
- [x] Add EnterPlanMode triggers for complex implementations
- Files affected: `skills/issue-setup/SKILL.md`

#### 2. Enhance work-session with Task & EnterPlanMode
- [x] Add Task, LSP, EnterPlanMode tools to frontmatter
- [x] Add complexity detection before task implementation
- [x] Add EnterPlanMode suggestion for complex tasks
- [x] Add Task delegation for complex subtasks
- [x] Add LSP usage for code navigation
- Files affected: `skills/work-session/SKILL.md`

#### 3. Add AskUserQuestion to review-pr
- [x] Add AskUserQuestion to frontmatter tools
- [x] Add confirmation dialog before submitting review to GitHub
- Files affected: `skills/review-pr/SKILL.md`

#### 4. Add AskUserQuestion to prime-session
- [x] Add AskUserQuestion to frontmatter tools
- [x] Add orientation depth selection after quick orientation
- Files affected: `skills/prime-session/SKILL.md`

#### 5. Strengthen Parallel Execution in archive-work
- [x] Add parallel execution for artifact detection
- Files affected: `skills/archive-work/SKILL.md`

### Quality Checks
- [x] All skills have consistent affordance usage
- [x] Tools lists in frontmatter are accurate
- [x] Documentation clearly explains when to use each affordance
- [x] No skill is over-engineered with affordances it doesn't need

## Technical Notes

### Architecture Considerations
- Skills are documentation that guides Claude behavior
- Frontmatter tools lists control what tools Claude can use
- Skills should suggest affordances, not mandate them
- Balance between comprehensive tooling and simplicity

### Implementation Approach
1. Start with issue-setup (most impactful - Task delegation + parallel)
2. Then work-session (EnterPlanMode is new capability)
3. Then review-pr and prime-session (AskUserQuestion additions)
4. Finally LSP integration (enhancement, not critical path)

### Potential Challenges
- Over-engineering skills with too many affordances
- Making skills too prescriptive vs letting Claude decide
- Balancing documentation length with clarity

## Questions/Blockers

### Clarifications Needed
None - issue requirements are clear.

### Assumptions Made
- Skills should suggest but not mandate affordance usage
- Parallel execution should be documented as "Execute in parallel" pattern
- LSP is optional enhancement, not required for all skills

## Work Log

### 2025-12-31 - Session Start
- Issue analyzed, branch created
- Scratchpad created with implementation plan
- Ready to begin implementation

### 2025-12-31 - Implementation Complete
- Enhanced issue-setup: Task delegation to Explore agent, parallel execution, LSP, EnterPlanMode triggers
- Enhanced work-session: Task, LSP, EnterPlanMode with complexity detection
- Enhanced review-pr: AskUserQuestion for submission confirmation
- Enhanced prime-session: AskUserQuestion for orientation depth
- Enhanced archive-work: Parallel artifact detection
- All 5 skills updated, 167 lines added

---
**Generated:** 2025-12-31
**By:** Issue Setup (manual)
**Source:** https://github.com/fusupo/muleteer/issues/3
