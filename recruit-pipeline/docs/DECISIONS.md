# Decisions

Architecture decision records — short notes on why, kept as the project evolves.

## ADR 1: Node/TS/Express for the backend, Python/FastAPI for scoring

Date: 2026-07-23

The product/API layer (jobs, applications, pipeline state) doesn't benefit from
Python's ML ecosystem, and reuses skills already built on other projects (Ajepe).
The scoring layer (CV parsing, matching, future embeddings work) benefits directly
from Python's tooling and is where AI infrastructure skill-building should happen.
Keeping them as separate services means the ML work can evolve independently
(swap Groq for a self-hosted model, add a vector DB) without touching the product
code.

## ADR 2: Local-first for Phase 1

Date: 2026-07-23

Cloud infrastructure decisions (GCP vs AWS, managed DB, storage buckets) are
deferred until the product works end-to-end locally. This avoids spending time on
infra for a product that hasn't been validated yet, and keeps Phase 1 fast.

## ADR 3: GCP vs AWS for Phase 3

Status: not yet decided. Candidates: GCP (fresh Professional Cloud Architect
certification) or AWS (used in the Phoenix DevOps Capstone with Terraform/Argo CD).
To be recorded here once decided.
