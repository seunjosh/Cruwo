import { Router } from "express";
import multer from "multer";
import path from "path";
import fetch from "node-fetch";
import { prisma } from "../lib/prisma";

export const applicationsRouter = Router();

const upload = multer({ dest: path.join(__dirname, "../../uploads") });
const SCORING_SERVICE_URL = process.env.SCORING_SERVICE_URL ?? "http://localhost:8000";

// Internal endpoint — called by the scoring agent's save_result tool.
// Saves the agent's decision AND, if it was "shortlist", reliably checks
// whether the job's target is now met and flags it for HR review.
// This check does NOT depend on the agent separately choosing to call
// get_shortlist_status/flag_job_for_review — it always runs, guaranteeing
// HR is notified whenever the pipeline is actually full.
applicationsRouter.patch("/internal/:id/result", async (req, res) => {
  const { id } = req.params;
  const { parsedData, score, reason, recommendation } = req.body;
  const application = await prisma.application.findUnique({ where: { id: Number(id) } });
  if (!application) {
    return res.status(404).json({ error: "application not found" });
  }
  const newStatus = recommendation === "shortlist" ? "shortlisted" : "rejected";
  const updated = await prisma.application.update({
    where: { id: Number(id) },
    data: {
      rawParsedData: JSON.stringify(parsedData),
      score,
      scoreReason: reason,
      status: newStatus,
    },
  });
    // Guaranteed check — runs every time a candidate is shortlisted, not
  // only if the agent remembers to check itself.
  if (newStatus === "shortlisted") {
    const job = await prisma.job.findUnique({ where: { id: application.jobId } });
    if (job && job.shortlistTarget != null && job.status === "open") {
      const shortlistedCount = await prisma.application.count({
        where: { jobId: job.id, status: "shortlisted" },
      });
      if (shortlistedCount >= job.shortlistTarget) {
        if (job.onTargetReached === "pause") {
          // Stop new applications immediately and flag for HR right away.
          await prisma.job.update({ where: { id: job.id }, data: { status: "pending_review" } });
        }
        // "collect" mode: leave status as "open" — intake continues, the job
        // still shows up in Review (any open job with a shortlisted
        // candidate already appears there), HR decides when to stop it.
      }
    }
  }
  res.json(updated);
});

// Submit a new application. Creates the record, then triggers the scoring
// agent — which now saves its own result via the internal endpoint above,
// so we just re-fetch the application afterward to see what it decided.
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

  if (job.status !== "open") {
    return res.status(409).json({ error: "This job is no longer accepting applications." });
  }

  const application = await prisma.application.create({
    data: {
      candidateName,
      candidateEmail,
      jobId: Number(jobId),
      cvFilePath: file.path,
      status: "received",
    },
  });

  try {
    const scoringResponse = await fetch(`${SCORING_SERVICE_URL}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cv_file_path: file.path,
        job_requirements: JSON.parse(job.requirements),
        application_id: application.id,
        job_id: job.id,
      }),
    });

    if (!scoringResponse.ok) {
      throw new Error(`Scoring service returned ${scoringResponse.status}`);
    }

    // The agent already saved the result itself via save_result — re-fetch
    // to see what it decided, rather than reading it out of this response.
    const updated = await prisma.application.findUnique({ where: { id: application.id } });
    return res.status(201).json(updated);
  } catch (err) {
    console.error("Scoring service call failed:", err);
    return res.status(201).json({
      ...application,
      warning: "Application received but screening could not run. It will show as 'received' until retried.",
    });
  }
});

// List applications for the main pipeline view. Archived ones are hidden
// by default so the active pipeline doesn't get cluttered.
applicationsRouter.get("/", async (req, res) => {
  const { jobId, includeArchived } = req.query;
  const applications = await prisma.application.findMany({
    where: {
      ...(jobId ? { jobId: Number(jobId) } : {}),
      ...(includeArchived === "true" ? {} : { archived: false }),
    },
    orderBy: { score: "desc" },
  });
  res.json(applications);
});

// Re-run scoring for an application — the agent saves its own result again;
// we just re-fetch afterward.
applicationsRouter.post("/:id/retry-score", async (req, res) => {
  const { id } = req.params;
  const application = await prisma.application.findUnique({ where: { id: Number(id) } });
  if (!application) {
    return res.status(404).json({ error: "application not found" });
  }

  const job = await prisma.job.findUnique({ where: { id: application.jobId } });
  if (!job) {
    return res.status(404).json({ error: "job not found" });
  }

  try {
    const scoringResponse = await fetch(`${SCORING_SERVICE_URL}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cv_file_path: application.cvFilePath,
        job_requirements: JSON.parse(job.requirements),
        application_id: application.id,
        job_id: job.id,
      }),
    });

    if (!scoringResponse.ok) {
      const detail = await scoringResponse.text();
      throw new Error(`Scoring service returned ${scoringResponse.status}: ${detail}`);
    }

    const updated = await prisma.application.findUnique({ where: { id: application.id } });
    return res.json(updated);
  } catch (err) {
    console.error("Retry scoring failed:", err);
    return res.status(502).json({ error: `Retry failed: ${err}` });
  }
});

// Serves a candidate's original uploaded CV so HR can view/download it
// directly, not just read the agent's parsed summary.
applicationsRouter.get("/:id/cv", async (req, res) => {
  const { id } = req.params;
  const application = await prisma.application.findUnique({ where: { id: Number(id) } });
  if (!application) {
    return res.status(404).json({ error: "application not found" });
  }
  res.download(application.cvFilePath, `${application.candidateName}_CV.pdf`);
});

// Toggle archive on any application, regardless of its outcome.
applicationsRouter.patch("/:id/archive", async (req, res) => {
  const { id } = req.params;
  const application = await prisma.application.findUnique({ where: { id: Number(id) } });
  if (!application) {
    return res.status(404).json({ error: "application not found" });
  }
  const updated = await prisma.application.update({
    where: { id: Number(id) },
    data: { archived: !application.archived },
  });
  res.json(updated);
});

// Permanently remove an application.
applicationsRouter.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const application = await prisma.application.findUnique({ where: { id: Number(id) } });
  if (!application) {
    return res.status(404).json({ error: "application not found" });
  }
  await prisma.application.delete({ where: { id: Number(id) } });
  res.status(204).send();
});

// The compiled shortlist for a job.
applicationsRouter.get("/shortlist/:jobId", async (req, res) => {
  const { jobId } = req.params;
  const shortlisted = await prisma.application.findMany({
    where: { jobId: Number(jobId), status: { in: ["shortlisted", "invited"] } },
    orderBy: { score: "desc" },
  });
  res.json(shortlisted);
});

