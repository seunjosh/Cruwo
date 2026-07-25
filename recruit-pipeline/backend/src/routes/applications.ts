import { Router } from "express";
import multer from "multer";
import path from "path";
import fetch from "node-fetch";
import { prisma } from "../lib/prisma";

export const applicationsRouter = Router();

const upload = multer({ dest: path.join(__dirname, "../../uploads") });

const SCORING_SERVICE_URL = process.env.SCORING_SERVICE_URL ?? "http://localhost:8000";

// The "commit" stage: candidate submits an application with a CV.
// This creates the record, then triggers the "test suite" (scoring service).
applicationsRouter.post("/", upload.single("cv"), async (req, res) => {
  const { candidateName, candidateEmail, jobId } = req.body;
  const file = req.file;

  if (!candidateName || !candidateEmail || !jobId || !file) {
    return res
      .status(400)
      .json({ error: "candidateName, candidateEmail, jobId, and cv file are required" });
  }

  const job = await prisma.job.findUnique({ where: { id: Number(jobId) } });
  if (!job) {
    return res.status(404).json({ error: "job not found" });
  }

  // Create the record first (the "commit") before running any checks.
  const application = await prisma.application.create({
    data: {
      candidateName,
      candidateEmail,
      jobId: Number(jobId),
      cvFilePath: file.path,
      status: "received",
    },
  });

  // Trigger the "test suite": send the CV + job requirements to the scoring service.
  try {
    const scoringResponse = await fetch(`${SCORING_SERVICE_URL}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cv_file_path: file.path,
        job_requirements: JSON.parse(job.requirements),
      }),
    });

    if (!scoringResponse.ok) {
      throw new Error(`Scoring service returned ${scoringResponse.status}`);
    }

    const result = (await scoringResponse.json()) as {
      parsed_data: unknown;
      score: number;
      reason: string;
    };

    const updated = await prisma.application.update({
      where: { id: application.id },
      data: {
        rawParsedData: JSON.stringify(result.parsed_data),
        score: result.score,
        scoreReason: result.reason,
        status: "screened",
      },
    });

    return res.status(201).json(updated);
  } catch (err) {
    // Screening failed to run — application still exists, just not yet screened.
    console.error("Scoring service call failed:", err);
    return res.status(201).json({
      ...application,
      warning: "Application received but screening could not run. It will show as 'received' until retried.",
    });
  }
});

// Recruiter dashboard: list all applications for a job, sorted by score.
applicationsRouter.get("/", async (req, res) => {
  const { jobId } = req.query;
  const applications = await prisma.application.findMany({
    where: jobId ? { jobId: Number(jobId) } : undefined,
    orderBy: { score: "desc" },
  });
  res.json(applications);
});
