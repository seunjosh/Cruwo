import json
import os

import pdfplumber
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from groq import Groq
from pydantic import BaseModel

load_dotenv()

app = FastAPI(title="Recruit Pipeline Scoring Service")

client = Groq(api_key=os.environ.get("GROQ_API_KEY"))
MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")


class ScoreRequest(BaseModel):
    cv_file_path: str
    job_requirements: list[str]


class ScoreResponse(BaseModel):
    parsed_data: dict
    score: float
    reason: str


def extract_text_from_pdf(file_path: str) -> str:
    text_parts = []
    with pdfplumber.open(file_path) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text)
    return "\n".join(text_parts)


def parse_and_score(cv_text: str, requirements: list[str]) -> dict:
    """Send the CV text and job requirements to the LLM in a single call,
    asking for structured JSON back: parsed candidate fields, a 0-100 match
    score, and a short reason. Keeping this as one call keeps latency and
    cost down for the MVP."""

    prompt = f"""You are screening a candidate's CV against a job's requirements.

Job requirements:
{json.dumps(requirements)}

CV text:
{cv_text[:6000]}

Return ONLY valid JSON, no other text, in this exact shape:
{{
  "parsed_data": {{
    "name": string,
    "skills": [string],
    "years_experience": number,
    "education": string
  }},
  "score": number (0-100, how well the candidate matches the requirements),
  "reason": string (one or two sentences explaining the score)
}}"""

    response = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2,
    )

    content = response.choices[0].message.content.strip()
    # Strip markdown code fences if the model added them despite instructions
    if content.startswith("```"):
        content = content.strip("`")
        content = content.replace("json\n", "", 1)

    return json.loads(content)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/score", response_model=ScoreResponse)
def score(req: ScoreRequest):
    try:
        cv_text = extract_text_from_pdf(req.cv_file_path)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read CV file: {e}")

    if not cv_text.strip():
        raise HTTPException(status_code=422, detail="No extractable text found in CV")

    try:
        result = parse_and_score(cv_text, req.job_requirements)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="Scoring model returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Scoring failed: {e}")

    return ScoreResponse(
        parsed_data=result["parsed_data"],
        score=result["score"],
        reason=result["reason"],
    )
