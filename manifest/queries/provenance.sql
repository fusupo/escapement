-- Provenance Query: Archive path lookup for completed items
-- See: docs/MANIFEST_SYSTEM_DESIGN_V2.md Section 9.5
--
-- Parameter: $1 = work item id
-- Returns the archive path for a completed item.
-- For richer provenance, the caller reads:
--   {archive_path}/README.md
--   {context-path}/INDEX.md

SELECT id, name, branch, archive_path
FROM work_items
WHERE id = $1
  AND archive_path IS NOT NULL;
