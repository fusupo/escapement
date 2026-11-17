-- Manifest System V2 Schema (SQLite)
-- See: docs/MANIFEST_SYSTEM_DESIGN_V2.md Section 7.2

CREATE TABLE work_items (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL
                    CHECK (kind IN (
                      'issue',
                      'capability',
                      'phase',
                      'track'
                    )),
    state           TEXT NOT NULL DEFAULT 'planned'
                    CHECK (state IN (
                      'planned',
                      'in_progress',
                      'done',
                      'deferred',
                      'cancelled'
                    )),
    repo            TEXT,
    issue_number    INTEGER,
    issue_url       TEXT,
    scope_hint      TEXT,
    branch          TEXT,
    archive_path    TEXT,
    predicted_files TEXT NOT NULL DEFAULT '[]',
    actual_files    TEXT NOT NULL DEFAULT '[]',
    meta            TEXT NOT NULL DEFAULT '{}',
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE edges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id     TEXT NOT NULL REFERENCES work_items(id),
    rel         TEXT NOT NULL
                CHECK (rel IN (
                  'depends_on',
                  'is_part_of',
                  'implemented_by'
                )),
    to_id       TEXT NOT NULL REFERENCES work_items(id),
    confidence  TEXT NOT NULL DEFAULT 'certain'
                CHECK (confidence IN ('certain', 'inferred', 'ambiguous')),
    meta        TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE (from_id, rel, to_id)
);

-- Indexes for work_items
CREATE INDEX idx_work_items_kind ON work_items(kind);
CREATE INDEX idx_work_items_state ON work_items(state);
CREATE INDEX idx_work_items_repo ON work_items(repo);

-- Indexes for edges
CREATE INDEX idx_edges_rel ON edges(rel);
CREATE INDEX idx_edges_from_id ON edges(from_id);
CREATE INDEX idx_edges_to_id ON edges(to_id);
CREATE INDEX idx_edges_confidence ON edges(confidence);
