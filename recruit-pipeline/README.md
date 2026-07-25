# Recruit Pipeline

A recruiting platform modeled as a CI/CD pipeline: an application is a commit, automated
screening is the test suite, shortlisting is a passing build, interviews are staging,
and an offer is production deploy. Rejected candidates are logged with a reason and
kept in a talent pool instead of being discarded.

## Architecture

- `frontend/` — React + TypeScript. Candidate application form and recruiter dashboard.
- `backend/` — Node.js + TypeScript + Express + Prisma. Owns applications, jobs,
  pipeline stage state, and the database.
- `scoring-service/` — Python + FastAPI. Parses CVs and scores candidates against a
  job's requirements. Called internally by the backend.
- `infra/` — Terraform, for the cloud migration phase (GCP or AWS). Empty for now —
  Phase 1 runs entirely locally.

See `docs/ARCHITECTURE.md` for the full system diagram and reasoning, and
`docs/DECISIONS.md` for why each technology was chosen.

## Phase 1 scope (current)

- Candidate submits an application with a CV (PDF).
- Backend stores the file locally and creates an `Application` record.
- Backend calls the scoring service, which extracts text from the CV, sends it to an
  LLM to structure it into fields, and returns a match score against the job's
  requirements.
- Recruiter dashboard lists all applications, sortable by score.

No cloud, no auth, no notifications yet — those are later phases. See
`docs/PIPELINE_STAGES.md` for the full roadmap.

## Running locally

Requirements: Node 20+, Python 3.11+, Docker (for MySQL), and a Groq API key.

```bash
# 1. Start the database
docker compose up -d mysql

# 2. Backend
cd backend
cp .env.example .env        # add your DATABASE_URL and SCORING_SERVICE_URL
npm install
npx prisma migrate dev
npm run dev                 # http://localhost:4000

# 3. Scoring service
cd ../scoring-service
cp .env.example .env        # add your GROQ_API_KEY
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# 4. Frontend
cd ../frontend
npm install
npm run dev                 # http://localhost:5173
```

Or, once Docker images are set up, `docker compose up` will run all four services
together.
