import "dotenv/config";
import express from "express";
import cors from "cors";
import { jobsRouter } from "./routes/jobs";
import { applicationsRouter } from "./routes/applications";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/jobs", jobsRouter);
app.use("/applications", applicationsRouter);

const PORT = process.env.PORT ?? 4000;
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
