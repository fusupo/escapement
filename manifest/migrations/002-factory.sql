-- Migration 2: factory runner tables (#59).
-- Design: docs/FACTORY_DESIGN.md §4.1, §4.7, §7.1.
-- Shipped migrations are frozen; change the schema with a new migration.

CREATE TABLE factory_runs (
  run_id              TEXT PRIMARY KEY,
  work_item           TEXT NOT NULL,      -- external work-item id given to `factory start`
  repo                TEXT NOT NULL,
  worktree_path       TEXT NOT NULL,
  branch              TEXT NOT NULL,
  target_ref          TEXT NOT NULL,
  artifact_dir        TEXT NOT NULL,
  deadline_at         TEXT,               -- set at approval; enforced by the runner
  issue_number        INTEGER,
  manifest_id         TEXT,               -- optional; never required to exist in work_items
  work_type           TEXT,
  state               TEXT NOT NULL
                      CHECK (state IN ('planned','approved','implementing','validating',
                                       'validated','pr_open','closed','blocked','escalated')),
  state_reason        TEXT,
  tier_proposed       TEXT,
  tier_actual         TEXT,
  contract_digest     TEXT,
  policy_version      TEXT,
  gate_recommendation TEXT,
  gate_reasons_json   TEXT,
  operator_action     TEXT,               -- merged_as_is | changes_requested | rejected | abandoned
  pr_number           INTEGER,
  merge_sha           TEXT,
  archive_path        TEXT,
  started_at          TEXT NOT NULL,
  ended_at            TEXT
);

CREATE TABLE factory_authorizations (
  run_id            TEXT NOT NULL REFERENCES factory_runs(run_id),
  contract_digest   TEXT NOT NULL,
  baseline_json     TEXT NOT NULL,        -- test/policy baseline at approval
  authorizes_json   TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('active','ended','revoked','superseded')),
  approved_at       TEXT NOT NULL,
  ended_at          TEXT,
  PRIMARY KEY (run_id, contract_digest)
);

-- At most one active authorization per run.
CREATE UNIQUE INDEX idx_factory_auth_active
  ON factory_authorizations(run_id) WHERE status = 'active';

CREATE TABLE factory_attempts (
  run_id            TEXT NOT NULL REFERENCES factory_runs(run_id),
  attempt           INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
                      ('checks_running','awaiting_review','finalizing','complete','interrupted')),
  owner_json        TEXT,                 -- {pid, start_time, command, host} of the current operation
  verdict_digest    TEXT,
  outcome           TEXT,
  head_sha          TEXT NOT NULL,
  target_sha        TEXT,
  contract_digest   TEXT NOT NULL,
  policy_version    TEXT NOT NULL,
  failed_phase      TEXT,
  findings_json     TEXT,
  flags_json        TEXT,
  report_path       TEXT,
  duration_s        INTEGER,
  tokens            INTEGER,
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  PRIMARY KEY (run_id, attempt)
);

CREATE TABLE factory_events (
  id                INTEGER PRIMARY KEY,
  run_id            TEXT REFERENCES factory_runs(run_id),
  kind              TEXT NOT NULL CHECK (kind IN
                      ('readiness','critique_finding','state_change','gate',
                       'operator_action','manual_outcome','defect','revert')),
  detail_json       TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Advisory locks shared by every factory process (§4.1): 'build' and 'worktree:{path}'.
CREATE TABLE factory_locks (
  name              TEXT PRIMARY KEY,
  owner_json        TEXT NOT NULL,        -- {pid, start_time, command, host, run_id}
  acquired_at       TEXT NOT NULL
);

CREATE INDEX idx_factory_runs_work_item ON factory_runs(work_item);
CREATE INDEX idx_factory_runs_state ON factory_runs(state);
CREATE INDEX idx_factory_events_run ON factory_events(run_id);
