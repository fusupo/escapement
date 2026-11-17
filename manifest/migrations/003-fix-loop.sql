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
--
-- A run's attempt budget is fixed when it is first approved, like its
-- deadline, so a later commit to the branch's settings can't change how
-- many times the fix loop goes round. NULL for runs approved before this
-- migration: they fall back to the settings.

ALTER TABLE factory_attempts ADD COLUMN error_cause TEXT
  CHECK (error_cause IS NULL OR error_cause IN ('code', 'run', 'environment'));
ALTER TABLE factory_attempts ADD COLUMN error_reason TEXT;
ALTER TABLE factory_runs ADD COLUMN max_attempts INTEGER
  CHECK (max_attempts IS NULL OR max_attempts >= 1);
