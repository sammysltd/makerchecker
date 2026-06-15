# Recording the demo GIFs / screenshots (do this yourself — not via AI)

AI-driven browser capture adds cursor overlays, click indicators, and timing
artifacts, so these must be recorded by a human with a real screen recorder.
Targets: `docs/assets/demo.gif` (README hero) and the per-page OG/social images.

## Hero GIF — `docs/assets/demo.gif`

**What to record:** the live demo at https://www.makerchecker.ai/demo/ (Cold
chain scenario, the default — it has the most striking chart).

**Walkthrough to capture (~15s):**
1. Land on the intro modal ("An AI agent catches an excursion").
2. Click **Start the run** → the analyst report + temperature chart render.
3. Click **Let it try to self-approve** → the red **DECISION DENIED** block appears; the audit trail logs `approval.decision_denied`.
4. Click **I'll decide it myself**, then scroll to the decision and click **Release** → run completes, **Chain verified ✓** goes green.
5. End on the "An agent in production, under control" finale.

**Tooling + settings:**
- macOS: [Kap](https://getkap.co/) or [Gifox](https://gifox.app/) (or `Cmd-Shift-5` → record, then convert to GIF).
- Crop to the content (~1280px wide), 12–15 fps, keep it under ~5 MB so it renders inline on GitHub/the site.
- Move slowly and pause ~1s on each key state (report, the red block, the green chain) so viewers can read it.
- Save to `docs/assets/demo.gif`. The README already references this exact path (`![Run viewer](docs/assets/demo.gif)`, under the live-demo link), so it lights up automatically once the file lands. Consider embedding it on the marketing homepage hero too.

## OG / social images

**Done.** The brand share card (`makerchecker-site/public/og.png`, 1200×630 — the
gradient `MAKERchecker` wordmark on ink) and the favicon/app icon
(`makerchecker-site/app/icon.svg`, the `Mc` mark) now exist, generated from
hand-authored SVGs (`public/og.svg`, `app/icon.svg`). Every page falls back to the
single `og.png`.

**GitHub repo settings (manual, web UI only):** Settings → General → Social
preview → upload `makerchecker-site/public/og.png`; set the org/repo avatar to
`makerchecker-site/public/icon-512.png`.

**Optional future polish:** per-page 1200×630 cards (home, the two verticals,
/compare, /demo) in `makerchecker-site/public/og/`, each wired to that page's
`openGraph.images`. Not needed for launch.
