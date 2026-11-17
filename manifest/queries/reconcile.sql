-- Reconciliation: Compare predicted_files vs actual_files for completed items
-- See: docs/MANIFEST_SYSTEM_DESIGN_V2.md Section 13.4
--
-- For each done item with both predicted and actual files populated,
-- computes hits (intersection), misses (actual - predicted),
-- and false positives (predicted - actual).

SELECT
  w.id,
  w.name,
  w.predicted_files,
  w.actual_files,
  COALESCE(
    (
      SELECT json_group_array(f)
      FROM (
        SELECT DISTINCT pf.value AS f
        FROM json_each(w.predicted_files) pf
        WHERE pf.value IN (SELECT af.value FROM json_each(w.actual_files) af)
        ORDER BY f
      )
    ),
    '[]'
  ) AS hits,
  COALESCE(
    (
      SELECT json_group_array(f)
      FROM (
        SELECT DISTINCT af.value AS f
        FROM json_each(w.actual_files) af
        WHERE af.value NOT IN (SELECT pf.value FROM json_each(w.predicted_files) pf)
        ORDER BY f
      )
    ),
    '[]'
  ) AS misses,
  COALESCE(
    (
      SELECT json_group_array(f)
      FROM (
        SELECT DISTINCT pf.value AS f
        FROM json_each(w.predicted_files) pf
        WHERE pf.value NOT IN (SELECT af.value FROM json_each(w.actual_files) af)
        ORDER BY f
      )
    ),
    '[]'
  ) AS false_positives
FROM work_items w
WHERE w.state = 'done'
  AND w.predicted_files <> '[]'
  AND w.actual_files <> '[]';
