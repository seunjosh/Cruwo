Cruwo — Agent-Driven Recruiting Pipeline
Cruwo turns hiring into a pipeline the way CI/CD turns code into a deployment: a candidate applies, an AI agent screens them against the role's requirements and decides whether to shortlist them, and once enough strong candidates are in, the agent hands a compiled shortlist to HR for a final human decision — including drafting the interview invitations.

It's built around three Gemini-powered agents (via Google's Agent Development Kit), each responsible for a distinct part of the hiring workflow, and a human-in-the-loop review step so nothing irreversible happens without a person confirming it.

Cruwo architecture diagram

The problem
Screening CVs by hand doesn't scale, and most "AI hiring tools" stop at scoring a resume and handing back a number. That leaves all the actual workflow — posting the role, tracking who's been reviewed, compiling a shortlist, writing the interview invite — as manual work again. Cruwo automates the full loop, not just the scoring step, while keeping a human explicitly in charge of the moment that matters most: deciding who actually gets an interview.

What it does
For candidates

Browse open roles with full descriptions before applying (Careers page)
Apply two ways: Quick Apply (CV only — the agent extracts everything else) or Guided Application (a few structured questions plus a CV, so the agent can cross-check what the candidate says against what's actually in their CV)
For the agent

Reads the CV, scores the candidate against the job's requirements, and decides shortlist or reject — using an actual multi-step tool-calling agent (not a single prompt-in/JSON-out call): the agent calls a tool to read the CV, calls a tool to save its own decision, checks the pipeline's shortlist status, and can flag the job for HR review — all as its own actions, not hardcoded logic wrapped around it
Drafts a full job posting (title, description, requirements) from a handful of recruiter keywords (role, years of experience, level, team)
Drafts a personalized interview invitation email per shortlisted candidate, referencing the specific reason they were shortlisted rather than sending a form letter
For HR

A live Pipeline view showing every candidate as a stage-tracker (Applied → Extracted → Scored → Shortlisted/Rejected), styled after a CI/CD pipeline run
A per-job policy for what happens once the shortlist target is hit: Pause (stop taking new applications, flag for review right away) or Keep collecting (build a larger qualified pool, HR decides when to stop) — set at posting time, changeable anytime from Manage Jobs
A Review page listing any job with shortlisted candidates — labeled "Target reached" once the configured shortlist size is hit — where HR can view each candidate's original CV, draft/edit/confirm interview invites, or stop the process entirely
A Manage Jobs page to edit, archive, delete, reopen, or pull a quick report on any posted role
Retry, archive, or remove any application at any stage of the pipeline
Why this design
Two apply paths feeding one agent — most hiring tools force one intake format. Cruwo lets a candidate choose speed (Quick Apply) or thoroughness (Guided Application), and both land in the same agent-scored pipeline, so the agent has to normalize genuinely different inputs into one consistent outcome.
Human-in-the-loop, not human-out-of-the-loop — the agent decides who to shortlist and drafts the outreach, but HR always reviews the drafted email and explicitly confirms before anything is sent. The system is autonomous in its reasoning, not in what it's allowed to finalize unsupervised.
A real tool-calling agent for the highest-stakes decision — the scoring agent doesn't just return a score; it takes actions (read the CV, save the result, check the pipeline, escalate to HR) as a sequence it decides on, the same pattern that makes agentic systems useful for real workflows instead of one-shot text generation.
Tech stack
Layer	Technology
Frontend	React + Vite (TypeScript)
Backend	Express + Prisma ORM
Database	MySQL (via Docker locally / Cloud SQL in production)
Agent service	FastAPI + Google Agent Development Kit (ADK)
Model	Gemini 3.5 Flash (via Gemini API / Vertex AI)
PDF parsing	pdfplumber
The three agents
cv_scoring_agent — tool-based, multi-step. Given a CV file path and a job's requirements, it calls its own tools to: extract the CV text, determine the candidate's parsed profile (name, skills, years of experience, education), score the match, decide shortlist/reject, save that result, and — if shortlisted — check whether the job's shortlist target has just been met.
job_posting_agent — takes a role, years of experience, seniority level, team, and any extra notes, and returns a complete job title, description, and requirements list for the recruiter to review before posting.
interview_invite_agent — given a job title, an optional proposed interview date, and the list of shortlisted candidates (with their scores and reasons), writes one personalized invitation email per candidate.
Project structure
recruit-pipeline/
├── frontend/          React + Vite UI
├── backend/           Express API + Prisma schema/migrations
├── scoring-service/   FastAPI service hosting the three ADK agents
├── docker-compose.yml MySQL for local development
└── package.json       Root launcher — runs all three services together
Spin-up instructions (local)
Prerequisites
Node.js 18+
Python 3.11
Docker Desktop
A Gemini API key (aistudio.google.com/apikey)
1. Clone and install
git clone <repo-url>
cd recruit-pipeline
npm install
2. Start the database
docker compose up -d
3. Configure environment variables
backend/.env

DATABASE_URL="mysql://root:<your-mysql-password>@localhost:3306/recruit_pipeline"
SCORING_SERVICE_URL="http://localhost:8000"
PORT=4000
scoring-service/.env

GOOGLE_API_KEY=<your-gemini-api-key>
GOOGLE_GENAI_USE_VERTEXAI=FALSE
BACKEND_URL=http://localhost:4000
4. Set up the database schema
cd backend
npx prisma migrate deploy
cd ..
5. Set up the scoring service's Python environment
cd scoring-service
python -m venv .venv
source .venv/Scripts/activate   # Windows (Git Bash); use .venv/bin/activate on macOS/Linux
pip install -r requirements.txt
cd ..
6. Run everything with one command
npm run dev
This starts the frontend (localhost:5173), backend (localhost:4000), and scoring service (localhost:8000) together in one terminal, using concurrently.

7. Try it
Open localhost:5173 → Post a Job → give it a role, years of experience, and team → review the agent's draft → confirm
Go to Careers, apply to that role via Quick Apply or Guided Application with a CV
Check Pipeline to watch the candidate move through the stages
If the job has a shortlist target set and it's been reached, check Review to see the shortlist and draft interview invites
Deploying to the cloud
The backend and scoring service are both stateless HTTP services and deploy cleanly to Cloud Run; the MySQL database maps directly to Cloud SQL (same schema, same Prisma setup — just point DATABASE_URL at the Cloud SQL instance). No architectural changes are needed to move from local Docker MySQL to Cloud SQL.

Roadmap — toward a multi-tenant SaaS platform
Cruwo today is a single-company pipeline. Turning it into a platform other companies can run their own hiring on means solving for multi-tenancy, integrations, and trust at scale. Rough direction, grouped by theme:

Multi-tenancy & access

Multiple companies/workspaces on one deployment, each with isolated jobs, candidates, and data
Role-based access control (recruiter, hiring manager, admin) with SSO/SAML for enterprise customers
Usage-based or seat-based subscription tiers, with billing and plan limits
Integrations

Job board syndication — post once, publish to LinkedIn, Indeed, and other boards automatically
Calendar integration (Google Calendar / Outlook) so the interview-invite agent can check real availability and book a slot directly, instead of just proposing a date
ATS/HRIS integrations (e.g. Workday, BambooHR) for companies that want Cruwo as a screening layer in front of their existing system
Slack/Teams notifications so HR gets the "shortlist ready for review" notification where they already work, not just inside the app
Real email sending (not just drafting) via a transactional provider, with reply tracking so candidate responses feed back into the pipeline
Webhooks and a public API so other tools can react to pipeline events (candidate shortlisted, job closed, invite sent)
More agent capability

A scheduling agent that negotiates interview times directly with candidates over email/calendar, not just proposing one date
An onboarding agent that picks up once a candidate accepts — generating offer letters, kicking off background checks, and handing off to an HR onboarding checklist
Per-company custom scoring rubrics — let a company weight requirements (e.g. "must-have" vs "nice-to-have") rather than using one general scoring instruction for every job
A sourcing agent that goes further upstream — drafting outbound outreach to passive candidates who match a role, not just screening inbound applicants
Bias and fairness auditing — surfacing scoring patterns across demographic-blind fields so companies can catch skew in what the agent is rewarding
Reliability & compliance at scale

Candidate-facing status tracking (a portal to check their own application status), reducing "where's my application" support load
Audit logs of every agent decision and every HR action, for compliance and dispute resolution
Formal consent and data-retention workflows — a clear disclosure that applications are AI-screened, an explicit consent step at application time, defined retention periods, and a real right-to-erasure flow (the current build's Remove action on any application is a first step toward this, but not a full compliance posture)
Multi-language support for both the UI and the agents' generated content (job postings, emails) for companies hiring across regions
White-labeling so agencies/staffing firms can run Cruwo under their own brand for their clients
Findings and learnings
Tool-based agents are meaningfully different from single-shot generation, and worth the extra complexity for the decision that matters most. The scoring agent went through two iterations: first a single prompt-in/JSON-out call, then a rebuild where the agent itself calls tools to read the CV, save its decision, and check the pipeline's state. The second version is a genuine multi-step agent making its own sequence of calls — closer to what "autonomous" is supposed to mean.
Reliability and agency are in tension, and the fix is to make the safety-critical trigger deterministic. An agent might occasionally skip a tool call it was instructed to make — or call one it shouldn't have. Both showed up during development: the "notify HR" trigger needed to run every time a candidate was shortlisted, independent of whether the agent separately chose to check; and separately, an unguarded internal endpoint let the agent pause a job it had no business pausing (no target set, or the wrong policy) simply because it called the tool. The fix in both cases was the same principle — move the actual guarantee into the backend logic itself, and let the agent's tool calls request an action without being trusted to have verified the precondition themselves.
Human-in-the-loop is a design decision, not a fallback. Early iterations considered auto-sending interview invites the moment a target was hit. The final design always shows HR the drafted email and requires explicit confirmation — a small addition that meaningfully changes what kind of system this is.
