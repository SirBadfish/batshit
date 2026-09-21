Batshit Google Sans Code font files
===================================

Google Sans Code is Batshit's monospaced font: code, paths, IDs, and terminal output (Josh's pick,
2026-09-21). Nunito Sans is the interface font.

Source: the Google Fonts CSS2 API (`family=Google+Sans+Code:ital,wght@0,300..800;1,300..800`), fetched
2026-09-21. Upstream project: github.com/googlefonts/googlesans-code. Licence: SIL Open Font License 1.1
(`LICENSE.txt`, copied from the upstream repository).

Variable weight 300 to 800, sliced by unicode-range exactly as Google Fonts serves them. Kept subsets:
latin, latin-ext, and vietnamese (upright and italic), plus symbols, symbols2 (box drawing for terminal
trees), and math (upright only). The adlam, canadian-aboriginal, cherokee, old-permic, and syriac slices
are left out. The `@font-face` rules live in `src/lib/styles/core/fonts.css`.
