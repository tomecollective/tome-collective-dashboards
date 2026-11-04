## Checklists (added Nov 2026)

Free for every reader. Card lists are static: `cards/<game>.json` is one bundle per game keyed by the JustTCG set id, built offline from public card databases (Pokémon: TCGdex, matched to JustTCG set names; 151 of 217 sets; promos, McDonald's sets and trainer kits have no public list). Each card carries number, name, rarity and the printings that exist for it (Normal, Reverse Holo, Holo, 1st Edition). Nothing about the checklist touches JustTCG or KV.

Progress is keyed by the Beehiiv subscription id the page already receives (`?sid=`), stored in D1 (`tome-checklists`, table `checklists`), with localStorage as the cache and fallback for readers who arrive without a sid. Newest `updated_at` wins across devices; the worker refuses more than one save per second per set and anything over 64 KB.

Rebuilding the bundle: `python3 gen.py` in the generator folder (fetches TCGdex per card, cached on disk), then `build_bundle.py`. Lorcana and One Piece bundles follow the same shape once a public source is wired (`cards/disney-lorcana.json`, `cards/one-piece-card-game.json`).
