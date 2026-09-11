# tables/

`fb.html` renders a sortable, color-tiered Fast Break board from data carried in the URL hash, so Beehiiv
posts can embed one iframe per article with no per-day file to commit.

    https://tomecollective.github.io/tome-collective-dashboards/tables/fb.html#<base64url JSON>

JSON shape: `{"h":[headers],"r":[[rank,player,team,opp,...stats]],"t":{"PTS":12.0,...},"sort":<col index, optional>}`.
Colour tiers vs. the per-player target whose key appears in the column header: 125%+ dark green,
100%+ light green, 90%+ gold, 75%+ light gold. Beehiiv strips `<script>` from HTML snippets but keeps
`<iframe>` on web posts, so the iframe goes inside the paid-only section of the article.
