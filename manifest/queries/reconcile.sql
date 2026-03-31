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
  ARRAY(
    SELECT f FROM (
      SELECT unnest(w.predicted_files) AS f
      INTERSECT
      SELECT unnest(w.actual_files) AS f
    ) h ORDER BY f
  ) AS hits,
  ARRAY(
    SELECT f FROM (
      SELECT unnest(w.actual_files) AS f
      EXCEPT
      SELECT unnest(w.predicted_files) AS f
    ) m ORDER BY f
  ) AS misses,
  ARRAY(
    SELECT f FROM (
      SELECT unnest(w.predicted_files) AS f
      EXCEPT
      SELECT unnest(w.actual_files) AS f
    ) fp ORDER BY f
  ) AS false_positives
FROM work_items w
WHERE w.state = 'done'
  AND w.predicted_files <> '{}'
  AND w.actual_files <> '{}';
