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
    AND w.predicted_files <> '[]'
    AND w.predicted_files IS NOT NULL
    AND COALESCE(json_extract(w.meta, '$.needs_human'), 0) = 0
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
  (
    SELECT json_group_array(af.value)
    FROM (
      SELECT DISTINCT af.value
      FROM json_each(a.predicted_files) af
      JOIN json_each(b.predicted_files) bf ON af.value = bf.value
      ORDER BY af.value
    ) af
  ) AS shared_files
FROM frontier a
JOIN frontier b ON a.id < b.id
WHERE EXISTS (
  SELECT 1 FROM json_each(a.predicted_files) af
  JOIN json_each(b.predicted_files) bf ON af.value = bf.value
);
