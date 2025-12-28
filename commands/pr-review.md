allowed-tools: GitHub(*), Linear(*)
description: Conduct comprehensive PR review with full sprint/roadmap context awareness
---

## Project Context
Current project scope and development approach: !`cat docs/dev/PROJECT_CONTEXT.md`

## PR & Issue Context Analysis
**PR Reference**: $ARGUMENTS

### **1. Issue Hierarchy Detection**
- Retrieve PR details and identify closing issue(s)
- **Parent Issue Discovery**: Check if closing issue is part of larger epic/initiative
- **Sibling Issues**: Identify related issues in same parent/epic/sprint
- **Dependency Mapping**: Find issues that depend on or block this work

### **2. Sprint/Roadmap Context**
- **Current Sprint**: List all issues in current sprint/milestone
- **Roadmap Position**: Understand where this work fits in project completion sequence
- **Remaining Work**: Catalog what's left to do in this epic/feature area
- **Planned Improvements**: Identify suggestions already captured in backlog

---

## Review Framework
Execute each perspective while **avoiding suggestions already planned or covered by upcoming work**:

### **1. Product Value Assessment**
**Focus**: Does this advance project capabilities toward stated goals?
- **Epic Progress**: How does this contribute to the larger feature/capability being built?
- **Incremental Value**: What specific value does this piece deliver independently?
- **Sprint Completion**: Does this unblock other planned work in the current sprint?

**Action**: Assess business value within the larger work context. **Avoid suggesting improvements already planned in sibling issues.**

---

### **2. Technical Implementation Review**
**Focus**: Code quality appropriate for current development velocity:
- **Architectural Fit**: Does this align with planned architecture from parent epic?
- **Integration Readiness**: Is this prepared for upcoming integration work in roadmap?
- **Technical Debt**: Are any shortcuts appropriate given upcoming refactoring work?

**Action**: Review for technical correctness within larger technical plan. **Skip suggestions covered by planned technical debt issues.**

---

### **3. Epic Integration & Coordination**
**Focus**: How this piece fits with related work:
- **Interface Consistency**: Does this establish patterns other issues will follow?
- **Shared Components**: Are reusable elements properly designed for upcoming sibling issues?
- **Integration Points**: Are handoff points clean for dependent work?

**Action**: Evaluate coordination with planned work. **Focus on enabling upcoming issues rather than comprehensive improvements.**

---

### **4. Sprint-Aware Quality Assessment**
**Focus**: Appropriate quality level for current epic phase:
- **Functional Completeness**: Does this deliver its specific scope without over-engineering?
- **Testing Strategy**: Is testing appropriate for this piece, considering planned E2E testing in later issues?
- **Documentation Needs**: What documentation is needed now vs. what's planned for epic completion?

**Action**: Assess quality within sprint context. **Defer suggestions already scheduled for later sprint work.**

---

### **5. Roadmap Impact Analysis**
**Focus**: Preparing for selective collaboration within larger context:
- **Epic Documentation**: Does this piece need individual docs or wait for epic completion?
- **API Stability**: Should interfaces be stabilized now or are changes planned in upcoming work?
- **Demonstration Readiness**: Can this be shown independently or only after epic completion?

**Action**: Evaluate within full roadmap context. **Highlight dependencies and coordination needs rather than isolated improvements.**

---

## Context-Aware Review Principles
- **Epic-Scoped Feedback**: Consider the full feature/capability being built
- **Sprint Coordination**: Understand what's planned vs. what's missing
- **Roadmap Respect**: Don't suggest work already captured in upcoming issues
- **Dependency Awareness**: Focus on enabling downstream work
- **Phase-Appropriate Quality**: Match quality expectations to epic completion timeline

**Provide feedback that enhances THIS piece while respecting the larger planned work context.**
