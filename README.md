# System Design Studio

Practice system design on Google Cloud. Pick a problem, drag GCP services onto a canvas, tune their sizes, and watch the monthly cost, capacity and latency estimates move. Submit for a rubric-based score with one-click fixes.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build
```

Requires Node 18.18+ (Node 20+ recommended). Stack: Next.js (App Router), React, TypeScript, Tailwind CSS 3, React Flow (`@xyflow/react`), lucide icons. No backend: designs, attempts and "studied" marks live in `localStorage`.

## What is in it

- **30 problems** across four levels (Beginner, Mid-level, Senior, Staff+). Each has requirements, scale assumptions, a reference budget, a database-fit rule and a weighted rubric.
- **38 Google Cloud services** (plus Client and Third-party nodes): Cloud Run, GKE, Compute Engine, Functions, Load Balancing, CDN / Media CDN, Cloud Armor, API Gateway, DNS, Cloud SQL, AlloyDB, Spanner, Firestore, Bigtable, Memorystore (Redis and Cluster), Cloud Storage, Pub/Sub, Managed Kafka, Cloud Tasks, Workflows, Scheduler, Dataflow, BigQuery, Vertex AI Search / Prediction, Elasticsearch on GKE, Maps, Transcoder, Identity Platform, Secret Manager, KMS, FCM, Logging and Monitoring.
- **Editor**: drag-and-drop canvas (like eraser.io), per-service config sliders, live cost per node and in total, a Cost tab, and an Estimates tab (load after CDN/cache, capacity vs need, estimated p95 latency).
- **Auto-size**: bumps services just enough to cover peak load with 30% headroom (only the dimensions the problem grades).
- **Submit**: scores Scalability, Reliability, Performance, Fit & security and Cost, explains every rubric item, and offers one-click fixes with their estimated monthly cost. "Show a suggested architecture" builds a best-estimate design by applying the fixes automatically.
- **Attempt history** with restore, design notes, JSON import / export.

## How scoring works

The evaluator (`src/lib/evaluate.ts`) is deterministic and has no network calls.

1. `analysis.ts` turns the design into numbers: peak load after CDN offload, cache absorption, compute / database / cache / storage capacity versus need, estimated synchronous-path latency, and the bill.
2. Each rubric item (`requirements.ts`) returns a 0..1 score and a human-readable detail. Items are weighted per problem.
3. Category scores are weighted averages. Cost is scored against the problem's reference budget, discounted if the design misses core requirements or is heavily over-provisioned.
4. Bonus items add up to 8 points. The pass bar rises with the level: 65, 70, 75, 80.

Work behind a queue is treated as asynchronous: it is not counted in the synchronous latency path or the front-line compute capacity.

## Cost and capacity numbers

All prices are **approximate on-demand list prices** (us-central1-ish, USD), rounded for learning. They ignore committed-use discounts, most free tiers, support plans and taxes. Capacity figures are rules of thumb, not SLAs. Check <https://cloud.google.com/pricing> before real budgeting. Everything lives in `src/lib/catalog.ts`, one `cost()` and `capacity()` function per service, so it is easy to update.

Problem traffic is deliberately scaled down in places (noted on each problem) so the estimated bills stay realistic.

## Project layout

```
src/
  app/                  # Next.js routes: / and /design/[id]
  components/           # Home, Editor (React Flow), Palette, ConfigPanel, panels, ResultsModal
  lib/
    catalog.ts          # GCP services: config fields, cost, capacity, latency
    problems/           # the 30 problems (beginner / mid / senior / staff)
    requirements.ts     # reusable rubric items + one-click fixes
    evaluate.ts         # scoring, suggestions, reference-architecture builder
    analysis.ts graph.ts cost.ts autosize.ts design.ts rubric.ts storage.ts format.ts types.ts
```

## Adding things

- **A service**: add an entry to `SERVICES` in `catalog.ts` (fields, `cost`, optional `capacity`, `provides` capabilities). If it needs an icon, add it to `components/icons.tsx`.
- **A problem**: add `mk({...})` to the matching file in `src/lib/problems/`. Pick rubric items with `R('req-id', weight)` (required) or `B(...)` (bonus). Set `scale`, `dbFit` and a `budgetUSD` around 1.25x what a good design costs.
- **A rubric item**: add it to `REQS` in `requirements.ts` with a `check` and (optionally) a `fix`.
