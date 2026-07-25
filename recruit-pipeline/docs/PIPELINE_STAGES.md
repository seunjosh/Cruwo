# Pipeline stages and roadmap

The recruiting flow, mapped to CI/CD concepts:

| Stage | CI/CD equivalent | Status |
|---|---|---|
| Application | Commit / trigger | Phase 1 |
| Automated screening | Test suite | Phase 1 |
| Shortlist | Passing build | Phase 2 |
| Interviews | Staging environment | Phase 2 |
| Offer | Production deploy | Phase 2 |
| Rejection | Failed build, logged | Phase 1 (basic), Phase 2 (feedback loop into talent pool) |

## Phase 1 — local MVP (current)

- [ ] `Job` model: title, description, requirements list
- [ ] `Application` model: candidate info, CV file path, raw parsed data, score, status
- [ ] Upload endpoint: accepts CV, stores it, calls scoring service, saves result
- [ ] Scoring service: extracts CV text, structures it via LLM, returns match score
- [ ] Recruiter dashboard: table of applications, sortable by score
- [ ] Candidate application form

## Phase 2 — full pipeline

- [ ] Manual stage gates for interviews (recruiter marks pass/fail, adds notes)
- [ ] Status history per application (audit trail, like a CI run log)
- [ ] Candidate notifications on stage transitions
- [ ] Talent pool: rejected candidates auto-tagged and searchable for future roles

## Phase 3 — cloud migration

- [ ] Decide GCP vs AWS
- [ ] Move file storage to cloud bucket
- [ ] Move database to managed instance
- [ ] Containerize both services
- [ ] Terraform the infrastructure
- [ ] Argo CD for deployment (reuse Phoenix DevOps Capstone pattern)

## Phase 4 — showcase and pilot

- [ ] Polish README with screenshots and architecture writeup
- [ ] Demo video
- [ ] Approach a small company to pilot it for a real hiring round
