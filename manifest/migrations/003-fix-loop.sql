-- Migration 3: the bounded fix loop (#92, docs/FACTORY_DESIGN.md §5.4, §6.2).
--
-- An attempt that ends in `error` records who can fix it, so the runner can
-- decide whether the run goes back to implementation or waits on a human:
--   code         the change caused it (a check timed out, the checks wrote
--                into the tree, test results the change broke)
--   run          the run's revision changed under it (HEAD moved, tree dirty)
--   environment  only the operator can fix it (a check couldn't start, setup
--                failed, a runner error)
-- Not every error attempt rewrites its report, so the cause lives here too.

ALTER TABLE factory_attempts ADD COLUMN error_cause TEXT
  CHECK (error_cause IS NULL OR error_cause IN ('code', 'run', 'environment'));
ALTER TABLE factory_attempts ADD COLUMN error_reason TEXT;
