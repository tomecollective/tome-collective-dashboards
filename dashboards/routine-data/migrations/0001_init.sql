-- tome-routine-data (D1, id d38e62ae-d35e-4366-9fc1-bfbb4473bc92)
-- Written by tome-lines, tome-tcg and tome-proxy on their existing crons so the
-- scheduled Claude routines can read the same numbers through the Cloudflare
-- connector (d1_database_query) instead of fetching *.workers.dev, which the
-- routines' sandbox cannot reach. Nothing here is served publicly.

-- One row per endpoint response, exactly as the endpoint returns it.
--   feed = 'lines.projection'      league = nba|nfl|wnba  for_date = slate date (YYYY-MM-DD, as ?date=)
--   feed = 'lines.record_summary'  league = ''            for_date = asof date (as ?asof=); per-segment "ledger" arrays removed
--   feed = 'tcg.chase_index'       league = ''            for_date = payload last_updated; the public (teaser) payload
-- A failed refresh never overwrites a good row: it only sets last_error/last_error_at.
CREATE TABLE IF NOT EXISTS feed_snapshots (
  feed          TEXT NOT NULL,
  league        TEXT NOT NULL DEFAULT '',
  for_date      TEXT NOT NULL,
  captured_at   TEXT NOT NULL,           -- ISO UTC of the last good write
  status        INTEGER NOT NULL,        -- HTTP status the endpoint returned for that write
  body          TEXT NOT NULL,           -- JSON
  last_error    TEXT,
  last_error_at TEXT,
  PRIMARY KEY (feed, league, for_date)
);

-- lines.projection flattened, one row per game (same values as the body).
CREATE TABLE IF NOT EXISTS projection_games (
  league                TEXT NOT NULL,
  for_date              TEXT NOT NULL,
  game_id               TEXT NOT NULL,
  home                  TEXT,
  away                  TEXT,
  home_nick             TEXT,
  away_nick             TEXT,
  postseason            INTEGER,
  projected_spread_home REAL,
  projected_total       REAL,
  market_spread_home    REAL,
  market_total          REAL,
  market_source         TEXT,
  side                  TEXT,
  side_pick             TEXT,
  side_edge             REAL,
  side_tier             TEXT,
  total                 TEXT,
  total_pick            TEXT,
  total_edge            REAL,
  total_tier            TEXT,
  captured_at           TEXT NOT NULL,
  PRIMARY KEY (league, for_date, game_id)
);

-- tome-proxy daily snapshot (Near Mint universe down to the $10 floor), one row per card per day.
-- game uses the snapshot names: pokemon, disney-lorcana, one-piece-card-game. date = snapshot UTC date.
CREATE TABLE IF NOT EXISTS tcg_prices (
  game    TEXT NOT NULL,
  date    TEXT NOT NULL,
  card_id TEXT NOT NULL,
  price   REAL NOT NULL,
  PRIMARY KEY (game, date, card_id)
);
CREATE INDEX IF NOT EXISTS tcg_prices_card ON tcg_prices (game, card_id, date);

-- Card details as of the last snapshot that saw the card.
CREATE TABLE IF NOT EXISTS tcg_cards (
  game         TEXT NOT NULL,
  card_id      TEXT NOT NULL,
  name         TEXT,
  set_id       TEXT,
  set_name     TEXT,
  number       TEXT,
  rarity       TEXT,
  printing     TEXT,
  tcgplayer_id TEXT,
  last_seen    TEXT NOT NULL,
  PRIMARY KEY (game, card_id)
);

-- One row per mirror run per worker, for the morning health check.
CREATE TABLE IF NOT EXISTS mirror_runs (
  worker   TEXT NOT NULL,
  ran_at   TEXT NOT NULL,
  ok       INTEGER NOT NULL,
  detail   TEXT,
  PRIMARY KEY (worker, ran_at)
);
