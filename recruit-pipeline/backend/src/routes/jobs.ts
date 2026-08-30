import { Router } from "express";
import fetch from "node-fetch";
import { prisma } from "../lib/prisma";

export const jobsRouter = Router();

const SCORING_SERVICE_URL = process.env.SCORING_SERVICE_URL ?? "http://localhost:8000";

// Internal endpoint — called by the scoring agent's get_shortlist_status
// tool. Tells the agent where the pipeline currently stands so IT can
// decide whether to escalate, rather than Node deciding for it.
jobsRouter.get("/internal/:id/shortlist-status", async (req, res) => {
  const { id } = req.params;
  const job = await prisma.job.findUnique({ where: { id: Number(id) } });
  if (!job) {
    return res.status(404).json({ error: "job not found" });
  }
  const shortlistedCount = await prisma.application.count({
    where: { jobId: job.id, status: "shortlisted" },
  });
  res.json({ shortlistedCount, target: job.shortlistTarget });
});

// Internal endpoint — called by the scoring agent's flag_job_for_review
// tool. The agent itself decides when to call this; Node just executes it.
jobsRouter.post("/internal/:id/flag-review", async (req, res) => {
  const { id } = req.params;
  const job = await prisma.job.findUnique({ where: { id: Number(id) } });
  if (!job) {
    return res.status(404).json({ error: "job not found" });
  }

  // Don't trust the agent's call blindly — verify the target is genuinely
  // set, the policy is "pause", and the count actually meets it before
  // acting. This is what stops the agent flagging a job that has no
  // target at all, or one on "collect" mode.
  if (job.shortlistTarget == null || job.onTargetReached !== "pause") {
    return res.json({ flagged: false, reason: "no target set or not on pause policy" });
  }

  const shortlistedCount = await prisma.application.count({
    where: { jobId: job.id, status: "shortlisted" },
  });

  if (shortlistedCount < job.shortlistTarget) {
    return res.json({ flagged: false, reason: "target not yet met" });
  }

  if (job.status === "open") {
    await prisma.job.update({ where: { id: job.id }, data: { status: "pending_review" } });
  }
  res.json({ flagged: true });
});

// Create a job posting (used when the recruiter confirms a draft).
// shortlistTarget is optional — if set, the agent flags the job for HR
// review once that many candidates have been shortlisted.
jobsRouter.post("/", async (req, res) => {
  const { title, description, requirements, shortlistTarget, onTargetReached  } = req.body;
  if (!title || !requirements) {
    return res.status(400).json({ error: "title and requirements are required" });
  }
  const job = await prisma.job.create({
    data: {
      title,
      description: description ?? "",
      requirements: JSON.stringify(requirements),
      shortlistTarget: shortlistTarget ? Number(shortlistTarget) : null,
      onTargetReached: onTargetReached ?? "pause",
    },
  });
  res.status(201).json(job);
});


// Directly reopens any job, regardless of current status — HR's explicit
// override, no policy logic involved. Lets a paused/closed job go back to
// accepting applications on Careers immediately.
jobsRouter.post("/:id/reopen", async (req, res) => {
  const { id } = req.params;
  const job = await prisma.job.findUnique({ where: { id: Number(id) } });
  if (!job) {
    return res.status(404).json({ error: "job not found" });
  }
  const updated = await prisma.job.update({
    where: { id: job.id },
    data: { status: "open" },
  });
  res.json(updated);
});


// Ask the job-posting agent to draft a job from a few keywords.
// This does NOT save anything — it just returns a draft for the recruiter to review.
jobsRouter.post("/draft", async (req, res) => {
  const { role, yearsExperience, level, team, extraNotes } = req.body;
  if (!role || !yearsExperience || !team) {
    return res
      .status(400)
      .json({ error: "role, yearsExperience, and team are required" });
  }

  try {
    const response = await fetch(`${SCORING_SERVICE_URL}/generate-job-description`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role,
        years_experience: yearsExperience,
        level: level ?? "",
        team,
        extra_notes: extraNotes ?? "",
      }),
    });

    if (!response.ok) {
      throw new Error(`Job-posting agent returned ${response.status}`);
    }

    const draft = (await response.json()) as {
      title: string;
      description: string;
      requirements: string[];
    };

    return res.json(draft);
  } catch (err) {
    console.error("Job draft generation failed:", err);
    return res.status(502).json({ error: "Could not generate job draft. Try again." });
  }
});

// List all jobs, newest first.
jobsRouter.get("/", async (_req, res) => {
  const jobs = await prisma.job.findMany({ orderBy: { createdAt: "desc" } });
  res.json(jobs);
});

// Jobs HR can review right now: anything already flagged "pending_review"
// (target hit — needs a decision), PLUS any open job that has at least
// one shortlisted candidate (target not set or not yet hit — HR can still
// browse and act early if they want, just not required to).
jobsRouter.get("/pending-review", async (_req, res) => {
  const jobs = await prisma.job.findMany({
    where: {
      OR: [
        { status: "pending_review" },
        { status: "open", applications: { some: { status: "shortlisted" } } },
      ],
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(jobs);
});


// Step 1 of the invite flow: HR wants to move forward — the agent drafts
// (but does NOT send) interview invitations for every shortlisted
// candidate, optionally including a proposed interview date. Nothing is
// finalized here; HR reviews these drafts in the UI before confirming.
jobsRouter.post("/:id/draft-invites", async (req, res) => {
  const { id } = req.params;
  const { interviewDate } = req.body; // optional, e.g. "2026-09-05"
  const job = await prisma.job.findUnique({ where: { id: Number(id) } });
  if (!job) {
    return res.status(404).json({ error: "job not found" });
  }

  const shortlisted = await prisma.application.findMany({
    where: { jobId: job.id, status: "shortlisted" },
  });

  if (shortlisted.length === 0) {
    return res.status(400).json({ error: "No shortlisted candidates to draft invites for." });
  }

  try {
    const response = await fetch(`${SCORING_SERVICE_URL}/draft-interview-invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_title: job.title,
        interview_date: interviewDate ?? "",
        candidates: shortlisted.map((c) => ({
          name: c.candidateName,
          score: c.score,
          reason: c.scoreReason,
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(`Interview invite agent returned ${response.status}`);
    }

    const { invites } = (await response.json()) as {
      invites: { name: string; subject: string; body: string }[];
    };

    // Save drafts WITHOUT marking as invited yet — HR still needs to confirm
    // (or edit) each one before anything is treated as final.
    for (const candidate of shortlisted) {
      const invite = invites.find((i) => i.name === candidate.candidateName);
      if (invite) {
        await prisma.application.update({
          where: { id: candidate.id },
          data: { interviewEmailSubject: invite.subject, interviewEmailBody: invite.body },
        });
      }
    }

    // Return the drafts fresh from the DB so the frontend has everything,
    // including each candidate's id (needed to confirm/send later).
    const updatedShortlist = await prisma.application.findMany({
      where: { jobId: job.id, status: "shortlisted" },
    });
    return res.json(updatedShortlist);
  } catch (err) {
    console.error("Drafting invites failed:", err);
    return res.status(502).json({ error: `Could not draft invites: ${err}` });
  }
});

// Step 2 of the invite flow: HR has reviewed (and possibly edited) the
// drafts in the UI — finalize them. Accepts the final subject/body per
// candidate, which may differ from what the agent originally drafted.
jobsRouter.post("/:id/confirm-invites", async (req, res) => {
  const { id } = req.params;
  const { invites } = req.body as { invites: { applicationId: number; subject: string; body: string }[] };

  const job = await prisma.job.findUnique({ where: { id: Number(id) } });
  if (!job) {
    return res.status(404).json({ error: "job not found" });
  }

  for (const invite of invites) {
    await prisma.application.update({
      where: { id: invite.applicationId },
      data: {
        interviewEmailSubject: invite.subject,
        interviewEmailBody: invite.body,
        status: "invited",
      },
    });
  }

  const updatedJob = await prisma.job.update({
    where: { id: job.id },
    data: { status: "invites_sent" },
  });

  res.json(updatedJob);
});

// HR reviewed the shortlist and decided not to proceed — closes the job
// without sending any invitations.
jobsRouter.post("/:id/stop-process", async (req, res) => {
  const { id } = req.params;
  const job = await prisma.job.findUnique({ where: { id: Number(id) } });
  if (!job) {
    return res.status(404).json({ error: "job not found" });
  }
  const updatedJob = await prisma.job.update({
    where: { id: job.id },
    data: { status: "closed" },
  });
  res.json(updatedJob);
});

// Edit an existing job's details. If the shortlist target changes and the
// job is still open, re-check whether it already meets the new target —
// this lets HR raise/lower headcount after the fact without re-scoring anyone.
jobsRouter.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { title, description, requirements, shortlistTarget, onTargetReached   } = req.body;

  const job = await prisma.job.findUnique({ where: { id: Number(id) } });
  if (!job) {
    return res.status(404).json({ error: "job not found" });
  }

  const updated = await prisma.job.update({
    where: { id: Number(id) },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(requirements !== undefined ? { requirements: JSON.stringify(requirements) } : {}),
      ...(shortlistTarget !== undefined ? { shortlistTarget: shortlistTarget ? Number(shortlistTarget) : null } : {}),
      ...(onTargetReached !== undefined ? { onTargetReached } : {}),
    },
  });

     // Switching to "collect" mode on a job that's currently paused should
  // reopen it — HR explicitly said they want to keep taking applications,
  // so it needs to show back up on Careers, not stay hidden.
  const effectiveOnTargetReached = onTargetReached ?? updated.onTargetReached;
  let finalStatus = updated.status;

  if (effectiveOnTargetReached === "collect" && finalStatus === "pending_review") {
    finalStatus = "open";
  }

  // If a new (lower) target now matches or is below the existing shortlist
  // count, and the policy is "pause", flag for review immediately rather
  // than waiting on a new applicant. Skip this entirely under "collect" —
  // that policy should never auto-pause.
  if (finalStatus === "open" && updated.shortlistTarget != null && effectiveOnTargetReached === "pause") {
    const shortlistedCount = await prisma.application.count({
      where: { jobId: updated.id, status: "shortlisted" },
    });
    if (shortlistedCount >= updated.shortlistTarget) {
      finalStatus = "pending_review";
    }
  }

  if (finalStatus !== updated.status) {
    await prisma.job.update({ where: { id: updated.id }, data: { status: finalStatus } });
  }

  const final = await prisma.job.findUnique({ where: { id: Number(id) } });
  res.json(final);
});
// Toggle archive on a job — hides it from Careers/active management views
// without deleting its history. Independent of status (open/closed/etc).
jobsRouter.patch("/:id/archive", async (req, res) => {
  const { id } = req.params;
  const job = await prisma.job.findUnique({ where: { id: Number(id) } });
  if (!job) {
    return res.status(404).json({ error: "job not found" });
  }
  const updated = await prisma.job.update({
    where: { id: Number(id) },
    data: { archived: !job.archived },
  });
  res.json(updated);
});

// Permanently delete a job and every application tied to it. Used for
// genuinely removing a mistaken/test posting, not routine housekeeping
// (that's what archive is for).
jobsRouter.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const job = await prisma.job.findUnique({ where: { id: Number(id) } });
  if (!job) {
    return res.status(404).json({ error: "job not found" });
  }
  await prisma.application.deleteMany({ where: { jobId: Number(id) } });
  await prisma.job.delete({ where: { id: Number(id) } });
  res.status(204).send();
});