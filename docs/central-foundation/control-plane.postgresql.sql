-- VERIDIA 中央控制面 PostgreSQL 草案。
-- 第一阶段不执行本文件，也不连接中央数据库。
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'DISABLED')),
  device_limit integer NOT NULL DEFAULT 3 CHECK (device_limit >= 0),
  offline_days integer NOT NULL DEFAULT 30 CHECK (offline_days BETWEEN 0 AND 90),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE central_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'DISABLED', 'LOCKED')),
  is_super_admin boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES central_users(id) ON DELETE CASCADE,
  role text NOT NULL
    CHECK (role IN ('ADMIN', 'AUDITOR', 'VIEWER')),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);

CREATE TABLE devices (
  id uuid PRIMARY KEY,
  device_label text,
  platform text NOT NULL DEFAULT 'WINDOWS'
    CHECK (platform = 'WINDOWS'),
  status text NOT NULL DEFAULT 'BOUND'
    CHECK (status IN ('BOUND', 'REVOKED', 'BLOCKED')),
  software_version text NOT NULL,
  rule_version text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES central_users(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'UNBOUND', 'FORCE_LOGOUT')),
  bound_at timestamptz NOT NULL DEFAULT now(),
  unbound_at timestamptz,
  last_verified_at timestamptz,
  UNIQUE (device_id, user_id, team_id)
);

CREATE INDEX device_bindings_user_status_idx
ON device_bindings(user_id, status);

CREATE TABLE refresh_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES central_users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  rotated_from uuid REFERENCES refresh_sessions(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_sessions_user_device_idx
ON refresh_sessions(user_id, device_id, expires_at);

CREATE TABLE offline_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES central_users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  grant_version integer NOT NULL,
  valid_until timestamptz NOT NULL,
  revoked_at timestamptz,
  issued_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX offline_grants_device_valid_idx
ON offline_grants(device_id, valid_until);

CREATE TABLE rule_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  version text NOT NULL,
  schema_version integer NOT NULL,
  minimum_client_version text NOT NULL,
  sha256 char(64) NOT NULL,
  signature text NOT NULL,
  storage_key text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PUBLISHED', 'REVOKED')),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, version)
);

CREATE TABLE usage_daily_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  summary_date date NOT NULL,
  user_id uuid NOT NULL REFERENCES central_users(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  software_version text NOT NULL,
  rule_version text NOT NULL,
  task_count integer NOT NULL DEFAULT 0 CHECK (task_count >= 0),
  audit_count integer NOT NULL DEFAULT 0 CHECK (audit_count >= 0),
  passed_count integer NOT NULL DEFAULT 0 CHECK (passed_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  review_count integer NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  non_sensitive_error_count integer NOT NULL DEFAULT 0
    CHECK (non_sensitive_error_count >= 0),
  idempotency_key text NOT NULL UNIQUE,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (summary_date, user_id, device_id)
);

CREATE INDEX usage_daily_team_date_idx
ON usage_daily_summaries(team_id, summary_date);

CREATE TABLE client_error_daily_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  summary_date date NOT NULL,
  user_id uuid NOT NULL REFERENCES central_users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  software_version text NOT NULL,
  error_code varchar(64) NOT NULL
    CHECK (error_code ~ '^[A-Z0-9_]{2,64}$'),
  error_count integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (summary_date, user_id, device_id, error_code)
);

CREATE TABLE admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES central_users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  request_id text NOT NULL,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_audit_logs_created_idx
ON admin_audit_logs(created_at DESC);
