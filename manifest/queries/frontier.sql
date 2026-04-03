-- Frontier Query: Dispatchable work items
-- See: docs/MANIFEST_SYSTEM_DESIGN_V2.md Section 9.1
--
-- Returns planned issue/capability work items that have:
--   1. No unmet dependencies (all depends_on targets are done)
--   2. No human gate (meta.needs_human is false or absent)

SELECT w.id, w.name, w.kind, w.repo, w.scope_hint, w.predicted_files
FROM work_items w
WHERE w.kind IN ('issue', 'capability')
  AND w.state = 'planned'
  AND COALESCE(json_extract(w.meta, '$.needs_human'), 0) = 0
  AND NOT EXISTS (
    SELECT 1
    FROM edges e
    JOIN work_items dep ON dep.id = e.to_id
    WHERE e.rel = 'depends_on'
      AND e.from_id = w.id
      AND dep.state != 'done'
  );
