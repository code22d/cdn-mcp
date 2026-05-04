-- =====================================================================
-- 0001_init.sql — initial schema for cdn-mcp
-- =====================================================================
-- Tables:
--   projects  — folders (one row per project, name is the PK)
--   files     — file metadata, source of truth (R2 has the bytes only)
--
-- Why D1 not KV: KV list() is eventually consistent (up to 60s window).
-- A user calling cdn_list_files immediately after cdn_upload_file would
-- find their file missing. D1 is strongly consistent and SQL-queryable.
-- =====================================================================

CREATE TABLE projects (
  name        TEXT PRIMARY KEY,
  description TEXT,
  created_at  TEXT NOT NULL          -- ISO-8601
);

CREATE TABLE files (
  id               TEXT PRIMARY KEY,    -- uuid
  project          TEXT NOT NULL REFERENCES projects(name),
  name             TEXT NOT NULL,       -- filename within project
  r2_key           TEXT NOT NULL UNIQUE,-- always {project}/{name}
  content_type     TEXT,
  size_bytes       INTEGER NOT NULL,
  public_url       TEXT NOT NULL,
  uploaded_at      TEXT NOT NULL,
  last_replaced_at TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  UNIQUE(project, name)
);

CREATE INDEX idx_files_project     ON files(project);
CREATE INDEX idx_files_uploaded_at ON files(uploaded_at);
