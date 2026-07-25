# Architecture

## System overview

```
Frontend (React)  --->  Backend API (Node/Express)  --->  Database (MySQL/Prisma)
                              |
                              v
                     Scoring service (Python/FastAPI)  --->  LLM API (Groq)
```

The backend owns product state: jobs, applications, pipeline stage, status history.
The scoring service is stateless — it receives a CV and a job's requirements, and
returns a structured candidate profile plus a match score. It does not touch the
database directly; the backend persists whatever the scoring service returns.

This split mirrors how real AI infrastructure is usually built: a product/API layer,
and a separate inference layer that can be scaled, swapped, or replaced (e.g. Groq
today, a self-hosted model later) without touching the product code.

## Why two services instead of one

- The backend's job (CRUD, auth, pipeline state) doesn't benefit from Python's ML
  ecosystem. Node/Express is a fine, fast choice for it.
- The scoring service's job (text extraction, structuring, matching) benefits
  directly from Python's tooling and is where future ML work (embeddings, a custom
  matching model, a vector DB) will happen. Keeping it separate means that work
  never touches the product layer.
- It's also a deliberate architecture decision for the portfolio: a polyglot system
  with a dedicated inference service is a stronger "AI infrastructure" story than a
  single monolith calling an external API.

## Phase 1 (current): fully local

- File storage: local disk (`backend/uploads/`)
- Database: MySQL running in Docker
- No auth, no cloud, no notifications

## Phase 3 (later): cloud migration

- File storage moves to a cloud storage bucket (GCS or S3)
- Database moves to a managed instance (Cloud SQL or RDS)
- Both services containerized and deployed via Terraform + Argo CD, following the
  same pattern as the Phoenix DevOps Capstone
- GCP vs AWS decision recorded in `DECISIONS.md` once made
