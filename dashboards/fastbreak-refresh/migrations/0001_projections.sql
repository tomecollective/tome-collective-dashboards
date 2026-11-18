-- Fast Break projections pulled from RotoWire (D1 database bound to
-- tome-fastbreak-refresh as PROJECTIONS_DB). One row per league/date/stat/player.
-- Only the night's objective stats are written, never the full RotoWire table.
-- A pull replaces that league/date/stat's rows in one batch:
--   DELETE FROM projections WHERE league = ? AND date = ? AND stat = ?;
--   INSERT INTO projections (league, date, stat, name, value, pulled_at) VALUES (...);
CREATE TABLE IF NOT EXISTS projections (
  league    TEXT NOT NULL,          -- "NBA" or "WNBA"
  date      TEXT NOT NULL,          -- YYYY-MM-DD (ET slate date)
  stat      TEXT NOT NULL,          -- Fast Break stat code: PTS, REB, AST, TOV, 3PM ...
  name      TEXT NOT NULL,          -- player name as RotoWire lists it
  value     REAL NOT NULL,          -- projected value for that stat
  source    TEXT NOT NULL DEFAULT 'rotowire',
  pulled_at TEXT NOT NULL,          -- ISO timestamp of the pull
  PRIMARY KEY (league, date, stat, name)
);
