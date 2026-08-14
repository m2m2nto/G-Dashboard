-- Users move out of gl-project.json into the database.
--
-- They were the only part of the manifest that changes while the app runs, and
-- the only part that is data rather than configuration: `audit_log.user` is
-- attributed from the active one on every logged action. What stays in the
-- manifest is the static description of the project — which Excel files it
-- holds — which has to be readable before any database is open.
--
-- `position` preserves the order the manifest's array had, since that is the
-- order the switcher lists them in. The partial unique index makes "at most one
-- active user" a property of the schema rather than of the code that writes it.
CREATE TABLE users (
  name      TEXT PRIMARY KEY,
  position  INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_users_single_active ON users(is_active) WHERE is_active = 1;
