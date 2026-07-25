import { useEffect, useState } from "react";

const API_URL = "http://localhost:4000";

type Job = {
  id: number;
  title: string;
};

type Application = {
  id: number;
  candidateName: string;
  candidateEmail: string;
  score: number | null;
  scoreReason: string | null;
  status: string;
  submittedAt: string;
};

function CreateJobForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [requirements, setRequirements] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setMessage(null);

    // Requirements are entered as one per line in the textarea.
    const requirementsList = requirements
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);

    try {
      const res = await fetch(`${API_URL}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, requirements: requirementsList }),
      });
      if (!res.ok) throw new Error(await res.text());
      setMessage("Job created.");
      setTitle("");
      setDescription("");
      setRequirements("");
      onCreated();
    } catch (err) {
      setMessage(`Something went wrong: ${err}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 400 }}>
      <h2>Create a job posting</h2>
      <input placeholder="Job title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      <textarea
        placeholder="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
      />
      <textarea
        placeholder={"Requirements, one per line\ne.g.\nNode.js\n3+ years experience\nSQL"}
        value={requirements}
        onChange={(e) => setRequirements(e.target.value)}
        rows={4}
        required
      />
      <button type="submit" disabled={submitting}>
        {submitting ? "Creating..." : "Create job"}
      </button>
      {message && <p>{message}</p>}
    </form>
  );
}

function ApplicationForm({ jobs, onSubmitted }: { jobs: Job[]; onSubmitted: () => void }) {
  const [candidateName, setCandidateName] = useState("");
  const [candidateEmail, setCandidateEmail] = useState("");
  const [jobId, setJobId] = useState<number | "">("");
  const [cv, setCv] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cv || !jobId) return;

    setSubmitting(true);
    setMessage(null);

    const formData = new FormData();
    formData.append("candidateName", candidateName);
    formData.append("candidateEmail", candidateEmail);
    formData.append("jobId", String(jobId));
    formData.append("cv", cv);

    try {
      const res = await fetch(`${API_URL}/applications`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error(await res.text());

const result = await res.json();

if (result.warning) {
  setMessage(`Application received, but screening didn't complete: ${result.warning}`);
} else if (result.status === "screened") {
  setMessage(`Application submitted and screened. Score: ${result.score}`);
} else {
  setMessage(`Application received. Status: ${result.status}`);
}

setCandidateName("");
setCandidateEmail("");
setCv(null);
onSubmitted();
} catch (err) {
setMessage(`Something went wrong: ${err}`);
} finally {
setSubmitting(false);
}
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 400 }}>
      <h2>Apply</h2>
      <input
        placeholder="Full name"
        value={candidateName}
        onChange={(e) => setCandidateName(e.target.value)}
        required
      />
      <input
        placeholder="Email"
        type="email"
        value={candidateEmail}
        onChange={(e) => setCandidateEmail(e.target.value)}
        required
      />
      <select value={jobId} onChange={(e) => setJobId(Number(e.target.value))} required>
        <option value="">Select a job</option>
        {jobs.map((job) => (
          <option key={job.id} value={job.id}>
            {job.title}
          </option>
        ))}
      </select>
      <input type="file" accept="application/pdf" onChange={(e) => setCv(e.target.files?.[0] ?? null)} required />
      <button type="submit" disabled={submitting}>
        {submitting ? "Submitting..." : "Submit application"}
      </button>
      {message && <p>{message}</p>}
    </form>
  );
}

function Dashboard({ applications }: { applications: Application[] }) {
  return (
    <div>
      <h2>Applications</h2>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Candidate</th>
            <th style={{ textAlign: "left" }}>Score</th>
            <th style={{ textAlign: "left" }}>Reason</th>
            <th style={{ textAlign: "left" }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {applications.map((app) => (
            <tr key={app.id}>
              <td>{app.candidateName}</td>
              <td>{app.score ?? "-"}</td>
              <td>{app.scoreReason ?? "-"}</td>
              <td>{app.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);

  const loadJobs = () => {
    fetch(`${API_URL}/jobs`)
      .then((res) => res.json())
      .then(setJobs);
  };

  const loadApplications = () => {
    fetch(`${API_URL}/applications`)
      .then((res) => res.json())
      .then(setApplications);
  };

  useEffect(() => {
    loadJobs();
    loadApplications();
  }, []);

  return (
    <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>Cruwo</h1>
      <CreateJobForm onCreated={loadJobs} />
      <hr style={{ margin: "24px 0" }} />
      <ApplicationForm jobs={jobs} onSubmitted={loadApplications} />
      <hr style={{ margin: "24px 0" }} />
      <Dashboard applications={applications} />
    </div>
  );
}
