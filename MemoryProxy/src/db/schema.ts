/**
 * SQLite schema for MemoryProxy local persistence.
 *
 * Three tables:
 *   - sessions:     persists session metadata (sessionInfo / agentDetail / taskDetail).
 *   - hook_cache:   persists prewarmed injection blocks per (session_id, hook_id).
 *   - asset_event:  persists the asset usage evidence chain
 *                   (recalled/selected/injected/used/validated/corrected/contributed)
 *                   — task 3「资产使用链路记录与可信归因」的落库点。
 *
 * Schema is created with `IF NOT EXISTS` so it's safe to call on every startup.
 * `schema_version` row in `meta` table allows future migrations.
 */

export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  -- Primary identifier. For pending_form / uninitialized rows we use the
  -- session_key as the id (since no real session_id exists yet); for
  -- initialized rows we use the control-plane returned session_id.
  session_id        TEXT PRIMARY KEY,
  session_key       TEXT NOT NULL,
  status            TEXT NOT NULL,
  agent_id          TEXT,
  task_id           TEXT,
  user_id           TEXT,
  -- Legacy column name; now stores the user_id from auth/verify (see sessionRepo.ts).
  -- Kept for backward compat with existing DB files.
  cb_user_id        TEXT,
  agent_detail_json TEXT,
  task_detail_json  TEXT,
  session_info_json TEXT,
  state_json        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_session_key ON sessions(session_key);
CREATE INDEX IF NOT EXISTS idx_sessions_status      ON sessions(status);

CREATE TABLE IF NOT EXISTS hook_cache (
  session_id  TEXT NOT NULL,
  hook_id     TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, hook_id),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

-- 资产使用证据链（任务三）。每条记录 = 一个资产在某一阶段的一个事实事件。
-- stage 为稳定枚举（recalled/selected/injected/used/validated/corrected/contributed），
-- 便于 GROUP BY 聚合回执；evidence_json 存结构化证据（工具调用/diff/验证器结果）。
CREATE TABLE IF NOT EXISTS asset_event (
  id             TEXT PRIMARY KEY,
  stage          TEXT NOT NULL,
  asset_id       TEXT NOT NULL,
  asset_type     TEXT NOT NULL,
  asset_version  TEXT,
  asset_name     TEXT,
  score          REAL,
  source_tag     TEXT,
  session_key    TEXT NOT NULL DEFAULT '',
  session_id     TEXT,
  task_id        TEXT,
  agent_id       TEXT,
  team_id        TEXT,
  user_id        TEXT,
  turn_seq       INTEGER,
  evidence_json  TEXT,
  confidence     TEXT,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_asset_event_session ON asset_event(session_key);
CREATE INDEX IF NOT EXISTS idx_asset_event_stage   ON asset_event(stage);
CREATE INDEX IF NOT EXISTS idx_asset_event_asset   ON asset_event(asset_id);
`;
