# PV ICSR Processing — the medicines hero demo

Pharmacovigilance runs on expedited clocks. 21 CFR 314.80 requires 15-day
expedited ICSRs ("Alert reports") for serious, unexpected adverse experiences,
transmitted in ICH E2B(R3) format. A late expedited report is a per-case,
dated, inspectable failure. Draft EU GMP Annex 22 (published July 7, 2025)
permits generative AI in non-critical tasks only with a qualified human
reviewing the output. AI drafts, a named human signs — this flow's
architecture.

## The safe / consequential asymmetry

The case-processor agent does the high-volume, low-stakes work itself: it
ingests the day's adverse-event cases and **proposes** which look serious and
unexpected (`case-triage`, low risk, ungated). Proposing carries no regulatory
weight, so the agent never waits on a human to surface a candidate.

The two acts that *do* carry weight are gated:

- `seriousness-assess` makes the **binding** serious-and-unexpected
  determination that **starts the 15-day expedited clock** (21 CFR 314.80).
- `e2b-submit` **transmits** the ICSR to the regulatory gateway in E2B(R3)
  format — the irreversible, one-way filing to FDA FAERS / EMA EudraVigilance.

Both are `risk_tier: high`. The engine's flow grammar will not publish a
high-risk skill unless a separation-enforcing approval gate precedes the step
that uses it (the `high_risk_requires_gate` rule), so the run parks at the
**medical-review gate** before either can run. AI drafts; a named physician
signs; only then does the clock start and the report file.

## Separation of duties

The SoD constraint enforces **independent medical review** — a quality-system
control under EU GVP (Module I) and the QPPV's oversight (US postmarketing
safety reporting: 21 CFR 314.80) — so the processor who triages a case may not
perform its medical review. It is enforced at runtime and
fails closed: the gate is identity-mode (`forbid_requester`), so the user who
triggered the run gets a 403 deciding it, and unauthenticated decisions are
refused.

## The planted cases

Triage is rule-based: serious AND unexpected is a candidate for the 15-day
expedited clock; everything else routes to periodic reporting. The data plants
two expedited cases among ten (the other eight are routine — non-serious and
expected):

- `P-4003` (Cardevol 10mg): acute liver failure, serious and unexpected — a
  15-day expedited report under 21 CFR 314.80.
- `P-4009` (Gastrelin 40mg): anaphylactic reaction, serious and unexpected,
  received from a foreign source (DE) — also 15-day. The expedited clock is
  source-independent.

`P-4005` (serious **but expected**) and `P-4007` (**non-serious** but
unexpected) are the deliberate near-misses: each trips one half of the test but
not both, so each routes to periodic reporting — exactly the line the medical
reviewer confirms at the gate.

## Run it

```bash
docker compose up   # from the repo root; seeds everything on first boot
export H='authorization: Bearer mk_...'   # admin key printed at first boot

curl -X POST localhost:3000/api/flows/pv-icsr-processing/runs -H "$H" -H 'content-type: application/json' -d '{}'
curl localhost:3000/api/approvals -H "$H"
curl -X POST localhost:3000/api/approvals/<id>/decision -H "$H" \
  -H 'content-type: application/json' -d '{"decision":"approved","reason":"Seriousness and expectedness confirmed for P-4003 and P-4009; file 15-day expedited ICSRs per 21 CFR 314.80"}'
curl localhost:3000/api/runs/<runId> -H "$H"
curl localhost:3000/api/audit/verify -H "$H"
```

Try to approve with the **same** key that triggered the run: you get a 403. The
binding seriousness call and the E2B(R3) submission only run after a *different*,
authenticated medical reviewer signs off.

Export the signed, offline-verifiable evidence for the run — every agent action,
the high-risk skills held behind the gate, grant state, and the reviewer's
recorded decision, verifiable with no system access:

```bash
docker compose exec server node dist/cli.js audit export --run <runId> --out icsr-evidence.json
```
