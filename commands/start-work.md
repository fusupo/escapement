Execute development work from SCRATCHPAD_{issue_number}.md:

1. VALIDATE SETUP
   - Confirm SCRATCHPAD_{issue_number}.md exists
   - Read and display the implementation checklist
   - Verify the feature branch exists
   - Switch to the feature branch(if not already there)
   - Resume work if already in progress(based on the checklist)

2. WORK THROUGH CHECKLIST
   For each unchecked item in the Implementation Checklist:
   
   a) Display current task: "Working on: {task description}"
   
   b) Implement the required changes
   
   c) Update SCRATCHPAD with:
      - Progress notes under a "## Work Log" section
      - Any decisions made or issues encountered
      - Code snippets for complex solutions
   
   d) Commit changes:
      - use the '/commit' command
      - Include relevant files only
   
   e) Check off completed item in SCRATCHPAD
   
   f) Show progress: "{X} of {Y} tasks complete"

3. CONTINUOUS SYNC
   - After every 2-3 commits, show option to push changes
   - Keep SCRATCHPAD updated with running notes
   - If blocked, add to Questions/Blockers section and ask the user what to do

4. COMPLETION CHECK
   When all items checked:
   - Run test suite (if applicable)
   - Check linting
   - Review git log to ensure all commits are meaningful
   - Update SCRATCHPAD with final status

5. CLEANUP OPTIONS
   Present options:
   "All tasks complete! Options:
   1. Archive SCRATCHPAD to docs/completed/
   2. Delete SCRATCHPAD
   3. Keep SCRATCHPAD in current location
   
   Select option (1-3):"

6. OPTIONALLY OPEN PR
   Present options:
   "Open pr? (y/n)"
   
   if user selects 'y' use "/open-pr" command

If work is interrupted:
- Save current progress state in SCRATCHPAD
- Note which item was in progress
- Can resume later by running command again
