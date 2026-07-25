import { Router } from "express";
import { prisma } from "../lib/prisma";

export const jobsRouter = Router();

// Create a job posting
jobsRouter.post("/", async (req, res) => {
  const { title, description, requirements } = req.body;
  if (!title || !requirements) {
    return res.status(400).json({ error: "title and requirements are required" });
  }
  const job = await prisma.job.create({
    data: {
      title,
      description: description ?? "",
      requirements: JSON.stringify(requirements),
    },
  });
  res.status(201).json(job);
});

// List all jobs
jobsRouter.get("/", async (_req, res) => {
  const jobs = await prisma.job.findMany({ orderBy: { createdAt: "desc" } });
  res.json(jobs);
});
