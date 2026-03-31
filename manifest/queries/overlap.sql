-- File Overlap Discovery: Contention detection across frontier items
-- See: docs/MANIFEST_SYSTEM_DESIGN_V2.md Section 9.2
--
-- Discovers pairs of frontier items that share predicted files.
-- Uses self-join with a.id < b.id to avoid duplicate pairs.
-- Does NOT persist overlap as graph structure -- this is planning data.

WITH frontier AS (
  SELECT w.id, w.predicted_files
  FROM work_items w
  WHERE w.kind IN ('issue', 'capability')
    AND w.state = 'planned'
    AND w.predicted_files <> '{}'
    AND COALESCE((w.meta->>'needs_human')::boolean, false) = false
    AND NOT EXISTS (
      SELECT 1
      FROM edges e
      JOIN work_items dep ON dep.id = e.to_id
      WHERE e.rel = 'depends_on'
        AND e.from_id = w.id
        AND dep.state != 'done'
    )
)
SELECT
  a.id AS node_a,
  b.id AS node_b,
  ARRAY(
    SELECT shared_file
    FROM (
      SELECT unnest(a.predicted_files) AS shared_file
      INTERSECT
      SELECT unnest(b.predicted_files) AS shared_file
    ) s
    ORDER BY shared_file
  ) AS shared_files
FROM frontier a
JOIN frontier b ON a.id < b.id
WHERE a.predicted_files && b.predicted_files;
