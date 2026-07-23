-- Aeterna SQLite Schema (v4.1)

CREATE TABLE IF NOT EXISTS players (
  id            TEXT PRIMARY KEY,
  wallet        TEXT NOT NULL UNIQUE,
  token_id      INTEGER UNIQUE,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL DEFAULT 'Brother',  -- Brother | Sister | Deacon | Bishop | Cardinal
  sex           TEXT NOT NULL,                    -- male | female
  x_handle      TEXT,
  level         INTEGER NOT NULL DEFAULT 1,
  devotion      INTEGER NOT NULL DEFAULT 0,
  streak        INTEGER NOT NULL DEFAULT 0,
  last_duty_date TEXT,                            -- YYYY-MM-DD
  pray_today    INTEGER DEFAULT 0,
  garden_today  INTEGER DEFAULT 0,
  candles_today INTEGER DEFAULT 0,
  gifts_given_today    INTEGER DEFAULT 0,
  gifts_received_today INTEGER DEFAULT 0,
  confession_count     INTEGER DEFAULT 0,         -- for escalating cost
  held_gift_id  TEXT,
  has_child     INTEGER DEFAULT 0,
  parent_id     TEXT,
  last_save     TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gifts (
  id            TEXT PRIMARY KEY,
  spawned_at    TEXT NOT NULL,
  loc_x         REAL,
  loc_y         REAL,
  picked_up_by  TEXT,
  given_to      TEXT,                             -- player id or 'guru'
  given_at      TEXT,
  expires_at    TEXT
);

CREATE TABLE IF NOT EXISTS saves (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id         TEXT NOT NULL,
  devotion_at_save  INTEGER NOT NULL,
  streak_at_save    INTEGER NOT NULL,
  signature         TEXT NOT NULL,
  signed_at         TEXT NOT NULL,
  used_for_level_up INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS streak_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id     TEXT NOT NULL,
  date          TEXT NOT NULL,
  streak_before INTEGER,
  broke         INTEGER DEFAULT 0,
  confessed     INTEGER DEFAULT 0,
  confessed_at  TEXT,
  cost_eth      REAL,
  tx_hash       TEXT
);

CREATE TABLE IF NOT EXISTS admin_awards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id   TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  reason      TEXT,
  awarded_by  TEXT DEFAULT 'admin',
  awarded_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS souls (
  soul_id     TEXT PRIMARY KEY,
  owner_id    TEXT,
  is_free     INTEGER DEFAULT 0,
  devotion    INTEGER DEFAULT 0,
  bound_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_players_devotion ON players(devotion DESC);
CREATE INDEX IF NOT EXISTS idx_players_wallet ON players(wallet);
CREATE INDEX IF NOT EXISTS idx_gifts_spawned ON gifts(spawned_at);
CREATE INDEX IF NOT EXISTS idx_saves_player ON saves(player_id);
