import json
import asyncio
import os
import pdfplumber
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

load_dotenv()
print("KEY LOADED:", bool(os.environ.get("GOOGLE_API_KEY")), "LENGTH:", len(os.environ.get("GOOGLE_API_KEY", "")))
app = FastAPI(title="Recruit Pipeline Scoring Service")

def extract_text_from_pdf(file_path: str) -> str:
    text_parts = []
    with pdfplumber.open(file_path) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text)
    return "\n".join(text_parts)

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:4000")

# ---------------------------------------------------------------------------
# Agent 1 (tool-based): CV scoring — this is a real multi-step agent now.
# Instead of Python code reading the CV before the call and Node saving the
# result after, the agent itself calls tools to read the CV, save its own
# decision, check the pipeline's shortlist status, and escalate to HR if
# the target has just been met. The agent decides which steps to take and
# when — it is not just producing text a script then acts on.
# ---------------------------------------------------------------------------

def make_scoring_tools(application_id: int, job_id: int):
    """Builds a fresh set of tools bound to one specific application/job,
    so the agent's tool calls don't need IDs threaded through its own
    reasoning text — the closure already knows which record it's acting on."""

    def extract_cv_text(file_path: str) -> dict:
        """Reads the candidate's CV PDF and returns its text content."""
        text_parts = []
        with pdfplumber.open(file_path) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    text_parts.append(page_text)
        text = "\n".join(text_parts)
        if not text.strip():
            return {"error": "No extractable text found in this CV"}
        return {"cv_text": text[:6000]}

    def save_result(parsed_data: dict, score: float, reason: str, recommendation: str) -> dict:
        """Saves the scoring outcome for this application. recommendation
        must be exactly 'shortlist' or 'reject'."""
        print(f"[TOOL] save_result called: recommendation={recommendation}, score={score}")
        resp = httpx.patch(
            f"{BACKEND_URL}/applications/internal/{application_id}/result",
            json={"parsedData": parsed_data, "score": score, "reason": reason, "recommendation": recommendation},
            timeout=10,
        )
        resp.raise_for_status()
        return {"saved": True}

    def get_shortlist_status() -> dict:
        """Checks how many candidates are currently shortlisted for this
        job, and the target (if any). Call this AFTER saving a 'shortlist'
        result, to check whether the pipeline has just been filled."""
        print(f"[TOOL] get_shortlist_status called for job {job_id}")
        resp = httpx.get(f"{BACKEND_URL}/jobs/internal/{job_id}/shortlist-status", timeout=10)
        resp.raise_for_status()
        return resp.json()  # {"shortlistedCount": int, "target": int | null}

    def flag_job_for_review() -> dict:
        """Marks this job as ready for HR review. Call this ONLY if
        get_shortlist_status shows shortlistedCount has reached target."""
        print(f"[TOOL] flag_job_for_review called for job {job_id}")
        resp = httpx.post(f"{BACKEND_URL}/jobs/internal/{job_id}/flag-review", timeout=10)
        resp.raise_for_status()
        return {"flagged": True}

    return [extract_cv_text, save_result, get_shortlist_status, flag_job_for_review]


AGENTIC_SCORING_INSTRUCTION = """You screen a candidate against a job's requirements, end to end, by taking real actions with your tools. Follow these steps in order:
1. Call extract_cv_text to read the CV.
2. From the CV text, determine the candidate's name, skills, years of experience, and education.
3. Score the match 0-100 against the given job requirements, and write a one or two sentence reason.
4. Decide a recommendation: "shortlist" if this is a strong enough match to move forward, otherwise "reject".
5. Call save_result with the parsed data, score, reason, and recommendation from steps 2-4. This is mandatory — always call it.
6. Only if your recommendation in step 4 was "shortlist": call get_shortlist_status.
7. Only if get_shortlist_status shows shortlistedCount has reached target (and target is not null): call flag_job_for_review.
Do not skip step 5. Do not call flag_job_for_review unless step 6 genuinely shows the target has been met. After completing the relevant steps, reply with a short confirmation of what you did — you do not need to return JSON, since the result is already saved via save_result."""


class ScoreRequest(BaseModel):
    cv_file_path: str
    job_requirements: list[str]
    application_id: int
    job_id: int


# --- shared helper: runs any agent and returns its raw text response, with retries ---
async def run_agent_with_retry(runner: Runner, session_service: InMemorySessionService,
                                app_name: str, prompt: str, max_attempts: int = 4) -> str:
    user_id, session_id = f"{app_name}_user", f"{app_name}_session"
    await session_service.create_session(app_name=app_name, user_id=user_id, session_id=session_id)
    content = types.Content(role="user", parts=[types.Part(text=prompt)])

    final_text = None
    last_error = None
    for attempt in range(1, max_attempts + 1):
        try:
            final_text = None
            async for event in runner.run_async(user_id=user_id, session_id=session_id, new_message=content):
                if event.is_final_response():
                    if event.content and event.content.parts:
                        final_text = event.content.parts[0].text
            if final_text is not None:
                break
            last_error = "empty final response"
        except Exception as e:
            last_error = str(e)

        if attempt < max_attempts:
            wait = attempt * 5
            print(f"[{app_name}] attempt {attempt} failed ({last_error}), retrying in {wait}s...")
            await asyncio.sleep(wait)

    if final_text is None:
        raise RuntimeError(f"Agent '{app_name}' failed after {max_attempts} attempts. Last error: {last_error}")
    return final_text

def extract_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`").replace("json\n", "", 1)
    return json.loads(text)


# --- job-posting agent: turns a few keywords into a full job description ---
job_posting_agent = Agent(
    name="job_posting_agent",
    model="gemini-3.5-flash",
    instruction="""You write clear, professional job postings from a few keywords a recruiter gives you.
Given a role title, years of experience, seniority level, team, and any extra notes, return ONLY valid JSON, no other text, in this exact shape:
{
  "title": string (a clean, professional job title),
  "description": string (2-4 sentences describing the role and what the person will do),
  "requirements": [string] (5-8 concrete requirements, mixing must-haves and nice-to-haves based on the level given)
}""",
)

# ---------------------------------------------------------------------------
# Agent 3: interview invitations — writes a personalized invite email for
# every shortlisted candidate at once. Triggered when HR clicks "Draft
# Invitations" on the Review page — nothing is sent automatically; HR
# reviews and can edit each draft before confirming.
# ---------------------------------------------------------------------------

interview_invite_agent = Agent(
    name="interview_invite_agent",
    model="gemini-3.5-flash",
    instruction="""You write warm, professional interview invitation emails.
Given a job title, an optional proposed interview date, and a list of shortlisted candidates (each with a name, score, and the reason they were shortlisted), write one personalized email per candidate inviting them to interview.
Each email should reference something specific from their reason for being shortlisted, so it doesn't read as a form letter.
If a proposed interview date is given, mention it clearly and ask the candidate to confirm their availability. If no date is given, ask the candidate to share their availability for the coming week instead.
Return ONLY valid JSON, no other text, in this exact shape:
{
  "invites": [
    {"name": string, "subject": string, "body": string}
  ]
}
There must be exactly one entry per candidate given, matching their name exactly.""",
)
interview_invite_session_service = InMemorySessionService()
interview_invite_runner = Runner(
    agent=interview_invite_agent,
    app_name="interview_invite",
    session_service=interview_invite_session_service,
)

class CandidateSummary(BaseModel):
    name: str
    score: float | None = None
    reason: str | None = None

class InterviewInviteRequest(BaseModel):
    job_title: str
    interview_date: str = ""  # optional, e.g. "2026-09-05" — HR-supplied proposed date
    candidates: list[CandidateSummary]

class InterviewInvite(BaseModel):
    name: str
    subject: str
    body: str

class InterviewInviteResponse(BaseModel):
    invites: list[InterviewInvite]

@app.post("/draft-interview-invites", response_model=InterviewInviteResponse)
async def draft_interview_invites(req: InterviewInviteRequest):
    candidates_text = "\n".join(
        f"- {c.name}: score {c.score}, reason: {c.reason}" for c in req.candidates
    )
    prompt = f"""Job title: {req.job_title}
Proposed interview date: {req.interview_date or "not specified — ask the candidate for their availability"}

Shortlisted candidates:
{candidates_text}"""
    try:
        raw = await run_agent_with_retry(
            interview_invite_runner, interview_invite_session_service, "interview_invite", prompt
        )
        result = extract_json(raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="Interview invite model returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Interview invite generation failed: {e}")
    return InterviewInviteResponse(**result)
    
job_posting_session_service = InMemorySessionService()
job_posting_runner = Runner(agent=job_posting_agent, app_name="job_posting", session_service=job_posting_session_service)

class JobDraftRequest(BaseModel):
    role: str
    years_experience: str
    level: str = ""
    team: str
    extra_notes: str = ""

class JobDraftResponse(BaseModel):
    title: str
    description: str
    requirements: list[str]

@app.post("/generate-job-description", response_model=JobDraftResponse)
async def generate_job_description(req: JobDraftRequest):
    prompt = f"""Role: {req.role}
Years of experience: {req.years_experience}
Level: {req.level or "not specified — infer an appropriate level from years of experience"}
Team: {req.team}
Extra notes: {req.extra_notes or "none"}"""
    try:
        raw = await run_agent_with_retry(job_posting_runner, job_posting_session_service, "job_posting", prompt)
        result = extract_json(raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="Job drafting model returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Job draft generation failed: {e}")
    return JobDraftResponse(**result)


# --- CV scoring endpoint ---
@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/score")
async def score(req: ScoreRequest):
    # A fresh agent per request — its tools are bound to this specific
    # application/job via closure, so it can only ever act on the record
    # it was actually asked to score.
    tools = make_scoring_tools(req.application_id, req.job_id)
    scoring_agent = Agent(
        name="cv_scoring_agent",
        model="gemini-3.5-flash",
        instruction=AGENTIC_SCORING_INSTRUCTION,
        tools=tools,
    )
    scoring_session_service = InMemorySessionService()
    scoring_runner = Runner(agent=scoring_agent, app_name="scoring", session_service=scoring_session_service)

    prompt = f"""Job requirements: {json.dumps(req.job_requirements)}
CV file path: {req.cv_file_path}
(Use extract_cv_text with this file path to read the CV.)"""

    try:
        await run_agent_with_retry(scoring_runner, scoring_session_service, "scoring", prompt)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Scoring failed: {e}")

    # The agent has already saved everything via save_result — this endpoint
    # just confirms the request was processed, it doesn't return the score itself.
    return {"status": "processed"}