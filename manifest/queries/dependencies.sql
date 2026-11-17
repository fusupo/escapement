-- Dependency Inspection: Blockers for a given work item
-- See: docs/MANIFEST_SYSTEM_DESIGN_V2.md Section 9.3
--
-- Parameter: ? = work item id
-- Returns all items that the given work item depends on,
-- with their current state (useful for identifying unmet blockers).

SELECT blocker.id, blocker.name, blocker.state
FROM edges e
JOIN work_items blocker ON blocker.id = e.to_id
WHERE e.rel = 'depends_on'
  AND e.from_id = ?
ORDER BY blocker.id;
