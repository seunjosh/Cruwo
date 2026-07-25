# API reference

## Backend (http://localhost:4000)

### `POST /jobs`
Create a job posting.
```json
{ "title": "Backend Engineer", "description": "...", "requirements": ["Node.js", "3+ years experience", "SQL"] }
```

### `GET /jobs`
List all jobs.

### `POST /applications` (multipart/form-data)
Submit a candidate application. Triggers screening automatically.
Fields: `candidateName`, `candidateEmail`, `jobId`, `cv` (file).

### `GET /applications?jobId=<id>`
List applications, sorted by score descending. Omit `jobId` to list all.

## Scoring service (http://localhost:8000)

### `POST /score`
Internal endpoint called by the backend. Not exposed to the frontend.
```json
{ "cv_file_path": "/path/to/cv.pdf", "job_requirements": ["Node.js", "3+ years experience"] }
```
Returns parsed candidate data, a 0-100 score, and a short reason.
