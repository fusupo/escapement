-- Supersession Detection: Find in_progress items potentially superseded by newer items
-- See: docs/MANIFEST_SYSTEM_DESIGN_V2.md Section 13.4
--
-- Identifies in_progress items whose predicted_files or scope_hint overlap
-- with newer planned or in_progress items (by updated_at).
-- Returns the older item and the newer item that may supersede it.

SELECT
  older.id          AS older_id,
  older.name        AS older_name,
  older.scope_hint  AS older_scope,
  newer.id          AS newer_id,
  newer.name        AS newer_name,
  newer.scope_hint  AS newer_scope,
  COALESCE(
    (
      SELECT json_group_array(af.value)
      FROM (
        SELECT DISTINCT af.value
        FROM json_each(older.predicted_files) af
        JOIN json_each(newer.predicted_files) bf ON af.value = bf.value
        ORDER BY af.value
      ) af
    ),
    '[]'
  ) AS shared_files
FROM work_items older
JOIN work_items newer
  ON newer.id != older.id
  AND newer.updated_at > older.updated_at
  AND newer.kind IN ('issue', 'capability')
  AND newer.state IN ('planned', 'in_progress')
WHERE older.kind IN ('issue', 'capability')
  AND older.state = 'in_progress'
  AND (
    -- File-based overlap
    EXISTS (
      SELECT 1 FROM json_each(older.predicted_files) af
      JOIN json_each(newer.predicted_files) bf ON af.value = bf.value
    )
    -- Scope-based overlap (both have scope_hint and they match)
    OR (
      older.scope_hint IS NOT NULL
      AND newer.scope_hint IS NOT NULL
      AND older.scope_hint = newer.scope_hint
    )
  )
ORDER BY older.id, newer.id;
