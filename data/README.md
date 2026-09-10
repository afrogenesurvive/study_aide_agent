# `data/`

Declarative, committed content. Nothing here is user data — user data lives in
`<userData>/study.db`.

| Path | What it is |
| :--- | :--- |
| `syllabi/*.json` | Starter Cambridge A-Level outlines for 9701 Chemistry, 9709 Mathematics and 9700 Biology. |
| `fixtures/*` | Small CSV/Markdown samples used by the parser tests. |
| `overlap-map.json` | Seeded cross-subject themes for overlap-based interleaving. |

## ⚠️ The starter syllabi are representative, not official

`syllabi/*.json` contain **topic headings only**. They are not the official
specification documents and must not be treated as authoritative — no learning
outcomes, assessment weightings or exam logistics are reproduced, and the topic
numbering is unlikely to match your board's exactly.

They exist for two reasons: to seed an empty app so the covered/coverage screens
have something to compute, and to give the CSV/Markdown/JSON importers realistic
input.

**The right way to get your real syllabus in:** Syllabus → Imports, then drop in
the official PDF, a CSV export, or a pasted outline. The importer diffs against
whatever is already stored and matches on `(syllabus_id, code)`, so your status
and valence tags survive the overwrite. Anything that disappears is archived
rather than deleted, and the whole import can be rolled back from the Imports tab.

## Why `overlap-map.json` is hand-written

The plan is to derive overlay themes by matching topic titles across the three
syllabi and then merge the results with this file. Until that derivation lands,
these four themes (`EQUILIBRIUM`, `EXPONENTIAL CHANGE`, `ENERGY`,
`STRUCTURE AND BONDING`) are the seed. Rows carry `"source": "seeded"` so a later
derivation pass can distinguish hand-written entries from generated ones.
