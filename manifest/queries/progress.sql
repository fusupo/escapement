-- Hierarchical Progress Rollup: Recursive phase/track completion stats
-- See: docs/MANIFEST_SYSTEM_DESIGN_V2.md Section 9.4
--
-- Walks the is_part_of hierarchy recursively from phases/tracks
-- down to leaf issue/capability items, counting total and done.

WITH RECURSIVE tree AS (
  SELECT
    parent.id AS root_id,
    child.id  AS child_id
  FROM work_items parent
  JOIN edges e ON e.to_id = parent.id AND e.rel = 'is_part_of'
  JOIN work_items child ON child.id = e.from_id
  WHERE parent.kind IN ('phase', 'track')

  UNION ALL

  SELECT
    tree.root_id,
    child.id
  FROM tree
  JOIN edges e ON e.to_id = tree.child_id AND e.rel = 'is_part_of'
  JOIN work_items child ON child.id = e.from_id
)
SELECT
  root.name,
  COUNT(CASE WHEN leaf.kind IN ('issue', 'capability') THEN 1 END) AS total_items,
  COUNT(CASE WHEN leaf.kind IN ('issue', 'capability') AND leaf.state = 'done' THEN 1 END) AS done_items
FROM tree
JOIN work_items root ON root.id = tree.root_id
JOIN work_items leaf ON leaf.id = tree.child_id
GROUP BY root.id, root.name
ORDER BY root.name;
