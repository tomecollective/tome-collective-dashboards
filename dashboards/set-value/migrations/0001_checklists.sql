-- Per-reader, per-set card checklists. sid = Beehiiv subscription id (identifier, not a credential).
CREATE TABLE IF NOT EXISTS checklists (
  sid        TEXT    NOT NULL,
  game       TEXT    NOT NULL,
  set_id     TEXT    NOT NULL,
  owned      TEXT    NOT NULL,   -- JSON: {"<card number>": ["Normal","Reverse Holo"], ...}
  updated_at INTEGER NOT NULL,   -- client clock, ms; newest wins across devices
  saved_at   INTEGER NOT NULL,   -- server clock, ms; used for the 1 write/second cap
  PRIMARY KEY (sid, game, set_id)
);
CREATE INDEX IF NOT EXISTS checklists_sid_game ON checklists (sid, game);
