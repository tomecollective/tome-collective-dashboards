# NFL banners

`nfl-preview-2026-09-09.png` and `nfl-recap-2026-09-09.png` are the templates. Dated copies for each game day are
generated, never redrawn: `python3 tools/stamp_banner_date.py nfl-preview-2026-09-09.png 2026-09-14 nfl-preview-2026-09-14.png`
(same for recap). The script erases the blue "GAME(S) ON ..." line with a patch of background from the empty rows
below it and re-renders the new date in Roboto Medium 18px with the template's tracking and color (tools/Roboto-Medium.ttf,
Apache 2.0). Needs Python 3 + Pillow; Claude runs it in its workspace and commits the PNGs here, then they are
pulled into Beehiiv from GitHub Pages.
