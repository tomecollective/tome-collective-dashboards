# Dashboards

All products here follow the **Tome Analytics: [Product]** naming convention.

- **`fastbreak/`** — **Tome Analytics: Fast Break**. NBA Top Shot Fast Break dashboard and
  lineup optimizer. Tome Edge tier. Not yet built.
- **`tcg/`** — Multiple products live under this folder:
  - **Tome Analytics: TCG Arbitrage** — Pokemon/Lorcana/One Piece pricing intelligence. Tome
    Vault tier. Not yet built.
  - **Tome Analytics: Pokemon Chase Modern 50** — the chase-card index and chart. Tome Vault
    tier. **Prototype exists** — see `tcg/README.md` for status and setup steps.
  - Future, not yet scoped: **Tome Analytics: Pokemon Chase Vintage 50**, **Tome Analytics:
    Lorcana Chase 50**, **Tome Analytics: One Piece Chase 50**. Note: unlike Pokemon, Lorcana
    and One Piece don't currently support a Modern/Vintage split — neither game has a real
    out-of-print market the way Pokemon's WOTC era does, so any future index for those games
    would be a single "Chase 50," not a paired Modern/Vintage set.

This structure is intentionally flat under `tcg/` rather than one-folder-per-product, since
several of these share the same underlying JustTCG data source and Worker pattern.
