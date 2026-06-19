# GMP Environmental-Monitoring Excursion Disposition

An aseptic fill line throws an **environmental-monitoring (EM) excursion**: viable
air sampling in a Grade B cleanroom records microbial counts (CFU) climbing well
past the validated action limit while a batch is on the line. An EM-monitor agent
pulls the excursion record, the validated alert/action limits, and the viable-air
sampling time-series, assesses the batch against those limits, and **quarantines
it itself**. The one-way door — **release the batch to market vs reject (destroy)
it**, six figures either way — belongs to a named **Quality Assurance** person in
the quality unit.

This is the same safe/consequential **asymmetry** as the cold-chain demo, re-skinned
from temperature to microbial contamination:

- The agent moves toward safety with **no gate**: a quarantined batch is neither
  released nor rejected, so the cost of being wrong is reversible. `batch-quarantine@1`
  is low risk and runs pre-gate.
- It is structurally stopped at the **irreversible** decision. `batch-disposition@1`
  is `risk_tier: high`, so the flow grammar forces an approval gate before the step
  that uses it. Publishing the same flow without that gate is rejected with
  `high_risk_requires_gate`.

GMP is the one domain where regulation mandates **both** controls at once: a **named
signature** on the batch record **and** an **independent** decision-maker. Under
**21 CFR 211.22** the quality control unit has the authority to approve or reject
all components, in-process materials, and finished products, and must be independent
of the production unit. The assessor (the EM monitor / production side) therefore
*cannot* be the approver — executor ≠ approver is not a nicety here, it is the rule.
EU GMP Annex 1 (2022) and ISO 14644-1/-2 supply the contamination-control limits the
assessment runs against.

## The seeded incident

`BATCH-7731` (Sterifil Injectable 50mg, 12,000 units, $318,000 on room
`GRADE-B-FILL-02`): a 13-point viable-air trace that **peaks at 38 CFU** against a
validated **10 CFU action limit** and spends about **180 minutes** at or above it,
past the validated **60-minute** excursion allowance. That is **beyond** the
contamination-control limit, so the monitor recommends **reject** and quarantines
the batch before the gate.

The same rule set produces the other outcomes the quality unit owns:

- **within / release** — the trace never reaches the action limit.
- **borderline / escalate** — over the limit but inside the validated allowance, or
  a product with **no validated EM limit on file** (fail safe: an unknown limit is
  never silently releasable).

## Run it

```bash
docker compose up   # from the repo root; seeds everything on first boot
# First boot prints two keys, each shown once: a DEMO ADMIN API KEY and a
# DEMO OFFICER API KEY. The monitor (admin) runs the assessment; QA (officer)
# owns the release-or-reject decision.
export H='authorization: Bearer mk_...'         # DEMO ADMIN API KEY (triggers the run)
export OFFICER='authorization: Bearer mk_...'   # DEMO OFFICER API KEY (decides disposition)

curl -X POST localhost:3000/api/flows/gmp-em-excursion-disposition/runs -H "$H" -H 'content-type: application/json' -d '{}'
curl localhost:3000/api/runs/<runId> -H "$H"   # see BATCH-7731 already HELD pre-gate
curl localhost:3000/api/approvals -H "$H"
curl -X POST localhost:3000/api/approvals/<id>/decision -H "$OFFICER" \
  -H 'content-type: application/json' -d '{"decision":"approved","reason":"Reject BATCH-7731: 38 CFU peak vs 10 CFU action limit, ~180 min over the 60 min allowance"}'
curl localhost:3000/api/audit/verify -H "$H"
```

The gate is identity-mode (`forbid_requester`): the monitor who assessed the
excursion gets a 403 deciding it (the SoD control firing, mirroring the 21 CFR 211.22
independence requirement), and unauthenticated decisions are refused (fail closed).
The DEMO OFFICER API KEY is the eligible QA approver, a different user than the one
that triggered.

## Files

- `excursions.csv` — the single batch incident: `batch_id, product, room, units, value_usd`.
- `em_limits.csv` — the validated contamination-control limits per product:
  `product, action_limit_cfu, max_excursion_minutes` (the cumulative time-over-limit allowance).
- `em_readings.csv` — the viable-air sampling time-series: `minute, cfu`.

## Citations

- **21 CFR 211.22** — Responsibilities of the quality control unit (independence;
  authority to approve or reject in-process materials and finished products).
- **EU GMP Annex 1 (2022)** — Manufacture of Sterile Medicinal Products
  (contamination control strategy; viable and total particle monitoring; action limits).
- **ISO 14644-1 / ISO 14644-2** — Cleanrooms and associated controlled environments
  (classification and monitoring of air cleanliness).
