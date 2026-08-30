
import { useEffect, useState } from "react";

// Backend API base URL — Express server (jobs, applications, scoring orchestration)
const API_URL = "http://localhost:4000";

type Job = {
  id: number;
  title: string;
  description?: string;
  requirements?: string; // JSON-encoded string array, as stored by the backend
  status?: string; // open | pending_review | invites_sent | closed
  shortlistTarget?: number | null;
  archived?: boolean;
};

type Application = {
  id: number;
  candidateName: string;
  candidateEmail: string;
  jobId: number;
  score: number | null;
  scoreReason: string | null;
  status: string; // received | screened | shortlisted | rejected | invited
  submittedAt: string;
  applicationMethod?: "quick" | "guided";
  archived?: boolean;
};

// The type returned by GET /applications/shortlist/:jobId and the draft-invites endpoint
type ShortlistedCandidate = {
  id: number;
  candidateName: string;
  candidateEmail: string;
  score: number | null;
  scoreReason: string | null;
  status: string;
  interviewEmailSubject?: string | null;
  interviewEmailBody?: string | null;
};

type JobReport = {
  total: number;
  received: number;
  shortlisted: number;
  rejected: number;
  invited: number;
};

// Maps a backend status string to a stage index for the pipeline stepper UI.
// "received" (not yet scored) falls through to index 0 via the -1 fallback.
function stageForStatus(status: string) {
  const order = ["applied", "screening", "screened", "shortlisted", "rejected"];
  const idx = order.indexOf(status);
  return idx === -1 ? 0 : idx;
}

// Small colored score badge — green/amber/red depending on how strong the match is.
function ScoreTag({ score }: { score: number | null }) {
  if (score == null) return <span className="score mid">—</span>;
  const cls = score >= 70 ? "high" : score >= 40 ? "mid" : "low";
  return <span className={`score ${cls}`}>{score}</span>;
}

// Renders one candidate as a horizontal pipeline "run" — Applied -> Extracted ->
// Scored -> Shortlisted/Rejected — mirroring a CI/CD pipeline visual.
// Retry, Archive, and Remove are available on every application, regardless
// of outcome — a recruiter may want to re-score, archive a decided
// candidate for later reference, or remove one outright at any stage.
function PipelineRun({ app, onChanged }: { app: Application; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);

  const stages = ["Applied", "Extracted", "Scored", app.status === "rejected" ? "Rejected" : "Shortlisted"];
  const activeIdx = app.status === "rejected" ? 3 : stageForStatus(app.status);

  const handleRetry = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/applications/${app.id}/retry-score`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      onChanged();
    } catch (err) {
      alert(`Retry failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const handleArchive = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/applications/${app.id}/archive`, { method: "PATCH" });
      if (!res.ok) throw new Error(await res.text());
      onChanged();
    } catch (err) {
      alert(`Archive failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    if (!confirm(`Remove ${app.candidateName} from the pipeline? This can't be undone.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/applications/${app.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      onChanged();
    } catch (err) {
      alert(`Remove failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="run">
      <div className="run-head">
        <span className="name">{app.candidateName}</span>
        <span className="method">{app.applicationMethod === "guided" ? "GUIDED" : "QUICK"}</span>
      </div>

      <div className="stages">
        {stages.map((label, i) => {
          const isLast = i === stages.length - 1;
          const failed = isLast && app.status === "rejected";
          const passed = i < activeIdx || (i === activeIdx && !failed && app.status !== "screening");
          const active = i === activeIdx && !passed && !failed;
          return (
            <div key={label} style={{ display: "contents" }}>
              <div className="stage">
                <div className={`stage-dot ${failed ? "fail" : passed ? "pass" : active ? "active" : ""}`} />
                <span className="stage-label">{label}</span>
              </div>
              {!isLast && <div className={`stage-line ${i < activeIdx ? "pass" : ""}`} />}
            </div>
          );
        })}
      </div>

      <div className="run-footer">
        <span>{app.scoreReason ?? "Awaiting screening"}</span>
        <ScoreTag score={app.score} />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn" style={{ padding: "6px 14px", fontSize: 12 }} onClick={handleRetry} disabled={busy}>
          {busy ? "Working..." : "Retry scoring"}
        </button>
        <button
          style={{
            padding: "6px 14px", fontSize: 12, background: "transparent",
            border: "1px solid var(--panel-border)", color: "var(--text)", borderRadius: 6, cursor: "pointer",
          }}
          onClick={handleArchive} disabled={busy}
        >
          Archive
        </button>
        <button
          style={{
            padding: "6px 14px", fontSize: 12, background: "transparent",
            border: "1px solid var(--red)", color: "var(--red)", borderRadius: 6, cursor: "pointer",
          }}
          onClick={handleRemove} disabled={busy}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

// Two-step "Post a Job" flow: recruiter gives a few keywords, the job-posting
// agent drafts a full title/description/requirements set, recruiter reviews
// and edits before confirming — the agent proposes, the human approves.
function CreateJobForm({ onCreated }: { onCreated: () => void }) {
  const [role, setRole] = useState("");
  const [yearsExperience, setYearsExperience] = useState("");
  const [level, setLevel] = useState("");
  const [team, setTeam] = useState("");
  const [extraNotes, setExtraNotes] = useState("");
  const [shortlistTarget, setShortlistTarget] = useState("");
  const [onTargetReached, setOnTargetReached] = useState("pause");

  const [draft, setDraft] = useState<{ title: string; description: string; requirements: string[] } | null>(null);

  const [drafting, setDrafting] = useState(false);
  const [posting, setPosting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleGenerateDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    setDrafting(true);
    setMessage(null);
    setDraft(null);
    try {
      const res = await fetch(`${API_URL}/jobs/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, yearsExperience, level, team, extraNotes }),
      });
      if (!res.ok) throw new Error(await res.text());
      const generated = await res.json();
      setDraft(generated);
    } catch (err) {
      setMessage(`Could not generate a draft: ${err}`);
    } finally {
      setDrafting(false);
    }
  };

  const handleConfirmPost = async () => {
    if (!draft) return;
    setPosting(true);
    setMessage(null);
    try {
      const res = await fetch(`${API_URL}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, shortlistTarget: shortlistTarget || null, onTargetReached  }),
      });
      if (!res.ok) throw new Error(await res.text());
      setMessage("Job posted.");
      setDraft(null);
      setRole(""); setYearsExperience(""); setTeam(""); setExtraNotes(""); setShortlistTarget("");
      onCreated();
    } catch (err) {
      setMessage(`Something went wrong posting the job: ${err}`);
    } finally {
      setPosting(false);
    }
  };

  if (draft) {
    return (
      <div className="panel">
        <h2>Review the draft</h2>
        <p className="desc">The agent wrote this from your keywords. Edit anything below, then confirm.</p>
        <div className="field">
          <label>Title</label>
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        </div>
        <div className="field">
          <label>Description</label>
          <textarea rows={4} value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </div>
        <div className="field">
          <label>Requirements (one per line)</label>
          <textarea rows={6} value={draft.requirements.join("\n")}
            onChange={(e) => setDraft({ ...draft, requirements: e.target.value.split("\n").filter(Boolean) })} />
        </div>
        <div className="field">
          <label>Shortlist target (optional)</label>
          <input
            type="number" min={1} value={shortlistTarget}
            onChange={(e) => setShortlistTarget(e.target.value)}
            placeholder="e.g. 5 — leave blank for unlimited"
          />
        </div>
        <div className="field">
  <label>When the target is reached</label>
  <select value={onTargetReached} onChange={(e) => setOnTargetReached(e.target.value)}>
    <option value="pause">Pause — stop new applications, notify me right away</option>
    <option value="collect">Keep collecting — build a larger pool, I'll decide when to stop</option>
  </select>
</div>


        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn" onClick={handleConfirmPost} disabled={posting}>
            {posting ? "Posting..." : "Confirm & Post"}
          </button>
          <button className="btn" style={{ background: "transparent", border: "1px solid var(--panel-border)", color: "var(--text)" }}
            onClick={() => setDraft(null)}>
            Start over
          </button>
        </div>
        {message && <p className="msg">{message}</p>}
      </div>
    );
  }

  return (
    <form onSubmit={handleGenerateDraft} className="panel">
      <h2>Post a job</h2>
      <p className="desc">Give the agent a few keywords. It drafts the full posting — you review before it goes live.</p>
      <div className="field">
        <label>Role</label>
        <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Frontend Engineer" required />
      </div>
      <div className="field">
        <label>Years of experience</label>
        <input value={yearsExperience} onChange={(e) => setYearsExperience(e.target.value)} placeholder="e.g. 2" required />
      </div>
      <div className="field">
        <label>Level (optional)</label>
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">Not specified</option>
          <option>Junior</option>
          <option>Mid</option>
          <option>Senior</option>
        </select>
      </div>
      <div className="field">
        <label>Team</label>
        <input value={team} onChange={(e) => setTeam(e.target.value)} placeholder="e.g. Frontend" required />
      </div>
      <div className="field">
        <label>Anything else? (optional)</label>
        <input value={extraNotes} onChange={(e) => setExtraNotes(e.target.value)} placeholder="e.g. must know Rust" />
      </div>
      <button className="btn" type="submit" disabled={drafting}>
        {drafting ? "Drafting..." : "Generate draft"}
      </button>
      {message && <p className="msg">{message}</p>}
    </form>
  );
}

function QuickApplyForm({ jobs, onSubmitted, preselectedJobId }: { jobs: Job[]; onSubmitted: () => void; preselectedJobId?: number | null }) {
  const [candidateName, setCandidateName] = useState("");
  const [candidateEmail, setCandidateEmail] = useState("");
  const [jobId, setJobId] = useState<number | "">(preselectedJobId ?? "");
  const [cv, setCv] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (preselectedJobId) setJobId(preselectedJobId);
  }, [preselectedJobId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cv || !jobId) return;
    setSubmitting(true);
    setMessage(null);

    const formData = new FormData();
    formData.append("candidateName", candidateName);
    formData.append("candidateEmail", candidateEmail);
    formData.append("jobId", String(jobId));
    formData.append("applicationMethod", "quick");
    formData.append("cv", cv);

    try {
      const res = await fetch(`${API_URL}/applications`, { method: "POST", body: formData });
      if (!res.ok) throw new Error(await res.text());
      const result = await res.json();
      setMessage(result.status === "screened" ? `Screened. Score: ${result.score}` : `Received. Status: ${result.status}`);
      setCandidateName(""); setCandidateEmail(""); setCv(null);
      onSubmitted();
    } catch (err) {
      setMessage(`Something went wrong: ${err}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="panel">
      <h2>Quick apply</h2>
      <p className="desc">Just drop your CV. The agent reads everything else from it.</p>
      <div className="field">
        <label>Full name</label>
        <input value={candidateName} onChange={(e) => setCandidateName(e.target.value)} required />
      </div>
      <div className="field">
        <label>Email</label>
        <input type="email" value={candidateEmail} onChange={(e) => setCandidateEmail(e.target.value)} required />
      </div>
      <div className="field">
        <label>Role</label>
        <select value={jobId} onChange={(e) => setJobId(Number(e.target.value))} required>
          <option value="">Select a role</option>
          {jobs.map((job) => <option key={job.id} value={job.id}>{job.title}</option>)}
        </select>
      </div>
      <div className="field">
        <label>CV (PDF)</label>
        <input type="file" accept="application/pdf" onChange={(e) => setCv(e.target.files?.[0] ?? null)} required />
      </div>
      <button className="btn" type="submit" disabled={submitting}>
        {submitting ? "Submitting..." : "Submit"}
      </button>
      {message && <p className="msg">{message}</p>}
    </form>
  );
}

function GuidedApplyForm({ jobs, onSubmitted, preselectedJobId }: { jobs: Job[]; onSubmitted: () => void; preselectedJobId?: number | null }) {
  const [candidateName, setCandidateName] = useState("");
  const [candidateEmail, setCandidateEmail] = useState("");
  const [jobId, setJobId] = useState<number | "">(preselectedJobId ?? "");
  const [yearsExperience, setYearsExperience] = useState("");
  const [topSkills, setTopSkills] = useState("");
  const [whyFit, setWhyFit] = useState("");
  const [cv, setCv] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (preselectedJobId) setJobId(preselectedJobId);
  }, [preselectedJobId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cv || !jobId) return;
    setSubmitting(true);
    setMessage(null);

    const formData = new FormData();
    formData.append("candidateName", candidateName);
    formData.append("candidateEmail", candidateEmail);
    formData.append("jobId", String(jobId));
    formData.append("applicationMethod", "guided");
    formData.append("yearsExperience", yearsExperience);
    formData.append("topSkills", topSkills);
    formData.append("whyFit", whyFit);
    formData.append("cv", cv);

    try {
      const res = await fetch(`${API_URL}/applications`, { method: "POST", body: formData });
      if (!res.ok) throw new Error(await res.text());
      const result = await res.json();
      setMessage(result.status === "screened" ? `Screened. Score: ${result.score}` : `Received. Status: ${result.status}`);
      setCandidateName(""); setCandidateEmail(""); setYearsExperience(""); setTopSkills(""); setWhyFit(""); setCv(null);
      onSubmitted();
    } catch (err) {
      setMessage(`Something went wrong: ${err}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="panel">
      <h2>Guided application</h2>
      <p className="desc">A few questions plus your CV. The agent checks your answers against what's actually in the CV.</p>
      <div className="field">
        <label>Full name</label>
        <input value={candidateName} onChange={(e) => setCandidateName(e.target.value)} required />
      </div>
      <div className="field">
        <label>Email</label>
        <input type="email" value={candidateEmail} onChange={(e) => setCandidateEmail(e.target.value)} required />
      </div>
      <div className="field">
        <label>Role</label>
        <select value={jobId} onChange={(e) => setJobId(Number(e.target.value))} required>
          <option value="">Select a role</option>
          {jobs.map((job) => <option key={job.id} value={job.id}>{job.title}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Years of experience</label>
        <input type="number" min={0} value={yearsExperience} onChange={(e) => setYearsExperience(e.target.value)} required />
      </div>
      <div className="field">
        <label>Top skills for this role</label>
        <input value={topSkills} onChange={(e) => setTopSkills(e.target.value)} placeholder="Python, AWS, system design" required />
      </div>
      <div className="field">
        <label>Why are you a fit? (1-2 sentences)</label>
        <textarea value={whyFit} onChange={(e) => setWhyFit(e.target.value)} rows={2} />
      </div>
      <div className="field">
        <label>CV (PDF)</label>
        <input type="file" accept="application/pdf" onChange={(e) => setCv(e.target.files?.[0] ?? null)} required />
      </div>
      <button className="btn" type="submit" disabled={submitting}>
        {submitting ? "Submitting..." : "Submit"}
      </button>
      {message && <p className="msg">{message}</p>}
    </form>
  );
}

function Careers({ jobs, onApply }: { jobs: Job[]; onApply: (jobId: number, path: "quick" | "guided") => void }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const openJobs = jobs.filter((j) => (j.status === "open" || j.status === undefined) && !j.archived);

  return (
    <div className="panel">
      <h2>Open roles</h2>
      <p className="desc">Browse current openings. Click a role to see the full description before applying.</p>
      {openJobs.length === 0 && <p className="msg">No open roles right now.</p>}
      {openJobs.map((job) => {
        const isExpanded = expandedId === job.id;
        let requirements: string[] = [];
        try {
          requirements = job.requirements ? JSON.parse(job.requirements) : [];
        } catch {
          requirements = [];
        }
        return (
          <div key={job.id} className="run">
            <div
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
              onClick={() => setExpandedId(isExpanded ? null : job.id)}
            >
              <span className="name">{job.title}</span>
              <span className="method">
  {job.status === "pending_review" ? "TARGET REACHED" : "IN PROGRESS"}
</span>
            </div>
            {isExpanded && (
              <div style={{ marginTop: 14 }}>
                <p className="msg" style={{ color: "var(--text)", marginBottom: 12 }}>{job.description}</p>
                {requirements.length > 0 && (
                  <>
                    <span className="stage-label">Requirements</span>
                    <ul style={{ margin: "8px 0 16px", paddingLeft: 18, color: "var(--text-dim)", fontSize: 13 }}>
                      {requirements.map((r, i) => <li key={i} style={{ marginBottom: 4 }}>{r}</li>)}
                    </ul>
                  </>
                )}
                <div style={{ display: "flex", gap: 10 }}>
                  <button className="btn" onClick={() => onApply(job.id, "quick")}>Quick Apply</button>
                  <button
                    className="btn"
                    style={{ background: "transparent", border: "1px solid var(--panel-border)", color: "var(--text)" }}
                    onClick={() => onApply(job.id, "guided")}
                  >
                    Guided Application
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Pipeline({ applications, onChanged }: { applications: Application[]; onChanged: () => void }) {
  return (
    <div className="panel">
      <h2>Pipeline</h2>
      <p className="desc">Every candidate, whichever path they applied through, scored by the same agent.</p>
      {applications.length === 0 && <p className="msg">No applications yet.</p>}
      {applications.map((app) => <PipelineRun key={app.id} app={app} onChanged={onChanged} />)}
    </div>
  );
}

// HR's review page — the one place a human confirms the agent's shortlist
// before anything irreversible happens. Any job with status "pending_review"
// shows up here (the tab label's live count is the "notification"). The
// flow is three steps: expand to see the shortlist -> draft invitations
// (agent writes them, nothing sent yet) -> review/edit each email -> confirm
// & send (or stop the process instead, at any point before confirming).
// Uses in-app confirm/cancel buttons throughout instead of browser popups.
function Review({ pendingJobs, onDecided }: { pendingJobs: Job[]; onDecided: () => void }) {
  const [expandedJobId, setExpandedJobId] = useState<number | null>(null);
  const [shortlist, setShortlist] = useState<ShortlistedCandidate[]>([]);
  const [loadingShortlist, setLoadingShortlist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [interviewDate, setInterviewDate] = useState("");
  const [showingDrafts, setShowingDrafts] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"send" | "stop" | null>(null);

  const currentJob = pendingJobs.find((j) => j.id === expandedJobId);

  const loadShortlist = async (jobId: number) => {
    setLoadingShortlist(true);
    try {
      const res = await fetch(`${API_URL}/applications/shortlist/${jobId}`);
      const data: ShortlistedCandidate[] = await res.json();
      setShortlist(data);
      setShowingDrafts(data.length > 0 && data.every((c) => !!c.interviewEmailSubject));
    } finally {
      setLoadingShortlist(false);
    }
  };

  const handleExpand = (jobId: number) => {
    if (expandedJobId === jobId) {
      setExpandedJobId(null);
      setStatusMsg(null);
      setConfirming(null);
      return;
    }
    setExpandedJobId(jobId);
    setStatusMsg(null);
    setConfirming(null);
    setInterviewDate("");
    loadShortlist(jobId);
  };

  const handleDraftInvites = async () => {
    if (!currentJob) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await fetch(`${API_URL}/jobs/${currentJob.id}/draft-invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interviewDate }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data: ShortlistedCandidate[] = await res.json();
      setShortlist(data);
      setShowingDrafts(true);
    } catch (err) {
      setStatusMsg(`Could not draft invitations: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const updateDraft = (id: number, field: "interviewEmailSubject" | "interviewEmailBody", value: string) => {
    setShortlist((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  };

  const handleConfirmSend = async () => {
    if (!currentJob) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await fetch(`${API_URL}/jobs/${currentJob.id}/confirm-invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invites: shortlist.map((c) => ({
            applicationId: c.id,
            subject: c.interviewEmailSubject ?? "",
            body: c.interviewEmailBody ?? "",
          })),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setConfirming(null);
      setExpandedJobId(null);
      onDecided();
    } catch (err) {
      setStatusMsg(`Sending failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const handleStopProcess = async () => {
    if (!currentJob) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await fetch(`${API_URL}/jobs/${currentJob.id}/stop-process`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      setConfirming(null);
      setExpandedJobId(null);
      onDecided();
    } catch (err) {
      setStatusMsg(`Stopping the process failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Review</h2>
      <p className="desc">
        Roles where the agent has reached the shortlist target and is waiting on your decision.
      </p>
      {pendingJobs.length === 0 && <p className="msg">Nothing waiting on review right now.</p>}
      {pendingJobs.map((job) => {
        const isExpanded = expandedJobId === job.id;
        return (
          <div key={job.id} className="run">
            <div
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
              onClick={() => handleExpand(job.id)}
            >
              <span className="name">{job.title}</span>
              <span className="method">{isExpanded ? "HIDE" : "REVIEW"}</span>
            </div>

            {isExpanded && (
              <div style={{ marginTop: 14 }}>
                {loadingShortlist && <p className="msg">Loading shortlist...</p>}

                {!loadingShortlist && !showingDrafts && (
                  <>
                    {shortlist.map((c) => (
  <div key={c.id} style={{ borderTop: "1px solid var(--panel-border)", paddingTop: 10, marginTop: 10 }}>
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ fontWeight: 700 }}>{c.candidateName}</span>
      <ScoreTag score={c.score} />
    </div>
    <p className="msg" style={{ color: "var(--text-dim)" }}>{c.scoreReason}</p>
    <a href={`${API_URL}/applications/${c.id}/cv`} target="_blank" rel="noreferrer" className="stage-label" style={{ textDecoration: "underline" }}>
      View CV
    </a>
  </div>
))}

                    <div className="field" style={{ marginTop: 16 }}>
                      <label>Proposed interview date (optional)</label>
                      <input
                        type="date"
                        value={interviewDate}
                        onChange={(e) => setInterviewDate(e.target.value)}
                      />
                    </div>

                    <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                      <button className="btn" onClick={handleDraftInvites} disabled={busy}>
                        {busy ? "Drafting..." : `Draft Invitation${shortlist.length > 1 ? "s" : ""}`}
                      </button>
                      {confirming === "stop" ? (
                        <>
                          <button
                            style={{ padding: "11px 20px", fontSize: 14, background: "var(--red)", color: "#1A0404", border: "none", borderRadius: 6, cursor: "pointer" }}
                            onClick={handleStopProcess} disabled={busy}
                          >
                            {busy ? "Working..." : "Confirm stop"}
                          </button>
                          <button
                            style={{ padding: "11px 20px", fontSize: 14, background: "transparent", border: "1px solid var(--panel-border)", color: "var(--text)", borderRadius: 6, cursor: "pointer" }}
                            onClick={() => setConfirming(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          style={{ padding: "11px 20px", fontSize: 14, background: "transparent", border: "1px solid var(--red)", color: "var(--red)", borderRadius: 6, cursor: "pointer" }}
                          onClick={() => setConfirming("stop")}
                        >
                          Stop Process
                        </button>
                      )}
                    </div>
                  </>
                )}

                {!loadingShortlist && showingDrafts && (
                  <>
                    <p className="msg" style={{ marginBottom: 12 }}>
                      The agent drafted the email{shortlist.length > 1 ? "s" : ""} below. Edit anything, then confirm to send.
                    </p>
                    {shortlist.map((c) => (
                      <div key={c.id} style={{ borderTop: "1px solid var(--panel-border)", paddingTop: 12, marginTop: 12 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                          <span style={{ fontWeight: 700 }}>{c.candidateName}</span>
                          <span className="stage-label">{c.candidateEmail}</span>
                        </div>
                        <div className="field">
                          <label>Subject</label>
                          <input
                            value={c.interviewEmailSubject ?? ""}
                            onChange={(e) => updateDraft(c.id, "interviewEmailSubject", e.target.value)}
                          />
                        </div>
                        <div className="field">
                          <label>Body</label>
                          <textarea
                            rows={6}
                            value={c.interviewEmailBody ?? ""}
                            onChange={(e) => updateDraft(c.id, "interviewEmailBody", e.target.value)}
                          />
                        </div>
                      </div>
                    ))}

                    <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                      {confirming === "send" ? (
                        <>
                          <button className="btn" onClick={handleConfirmSend} disabled={busy}>
                            {busy ? "Sending..." : "Yes, send now"}
                          </button>
                          <button
                            style={{ padding: "11px 20px", fontSize: 14, background: "transparent", border: "1px solid var(--panel-border)", color: "var(--text)", borderRadius: 6, cursor: "pointer" }}
                            onClick={() => setConfirming(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button className="btn" onClick={() => setConfirming("send")} disabled={busy}>
                          Confirm &amp; Send
                        </button>
                      )}
                      <button
                        style={{ padding: "11px 20px", fontSize: 14, background: "transparent", border: "1px solid var(--panel-border)", color: "var(--text-dim)", borderRadius: 6, cursor: "pointer" }}
                        onClick={() => setShowingDrafts(false)}
                      >
                        Back
                      </button>
                    </div>
                  </>
                )}

                {statusMsg && <p className="msg" style={{ marginTop: 10 }}>{statusMsg}</p>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// HR's job management page: edit a job's details/target, archive it (hide
// from Careers without deleting history), delete it outright, or expand a
// simple report of how its applications have broken down. The report is
// built entirely from applications already loaded in the app — no extra call.
function ManageJobs({ jobs, applications, onChanged }: { jobs: Job[]; applications: Application[]; onChanged: () => void }) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editRequirements, setEditRequirements] = useState("");
  const [editShortlistTarget, setEditShortlistTarget] = useState("");
  const [editOnTargetReached, setEditOnTargetReached] = useState("pause");
  const [reportJobId, setReportJobId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(null);

  const activeJobs = jobs.filter((j) => !j.archived);
  const archivedJobs = jobs.filter((j) => j.archived);

  const startEdit = (job: Job) => {
    setEditingId(job.id);
    setEditTitle(job.title);
    setEditDescription(job.description ?? "");
    let reqs: string[] = [];
    try {
      reqs = job.requirements ? JSON.parse(job.requirements) : [];
    } catch {
      reqs = [];
    }
    setEditRequirements(reqs.join("\n"));
    setEditShortlistTarget(job.shortlistTarget != null ? String(job.shortlistTarget) : "");
    setEditOnTargetReached((job as any).onTargetReached ?? "pause");
  };

  const handleSaveEdit = async (jobId: number) => {
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editTitle,
          description: editDescription,
          requirements: editRequirements.split("\n").filter(Boolean),
          shortlistTarget: editShortlistTarget || null,
          onTargetReached: editOnTargetReached,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setEditingId(null);
      onChanged();
    } catch (err) {
      alert(`Save failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const handleArchive = async (jobId: number) => {
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/jobs/${jobId}/archive`, { method: "PATCH" });
      if (!res.ok) throw new Error(await res.text());
      onChanged();
    } catch (err) {
      alert(`Archive failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };



  const handleReopen = async (jobId: number) => {
  setBusy(true);
  try {
    const res = await fetch(`${API_URL}/jobs/${jobId}/reopen`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    onChanged();
  } catch (err) {
    alert(`Reopen failed: ${err}`);
  } finally {
    setBusy(false);
  }
};


  const handleDelete = async (jobId: number) => {
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/jobs/${jobId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      setConfirmingDeleteId(null);
      onChanged();
    } catch (err) {
      alert(`Delete failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const buildReport = (jobId: number): JobReport => {
    const jobApps = applications.filter((a) => a.jobId === jobId);
    return {
      total: jobApps.length,
      received: jobApps.filter((a) => a.status === "received").length,
      shortlisted: jobApps.filter((a) => a.status === "shortlisted").length,
      rejected: jobApps.filter((a) => a.status === "rejected").length,
      invited: jobApps.filter((a) => a.status === "invited").length,
    };
  };

  const renderJobRow = (job: Job) => {
    const isEditing = editingId === job.id;
    const isReporting = reportJobId === job.id;

    if (isEditing) {
      return (
        <div key={job.id} className="run">
          <div className="field">
            <label>Title</label>
            <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
          </div>
          <div className="field">
            <label>Description</label>
            <textarea rows={4} value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
          </div>
          <div className="field">
            <label>Requirements (one per line)</label>
            <textarea rows={6} value={editRequirements} onChange={(e) => setEditRequirements(e.target.value)} />
          </div>
          <div className="field">
            <label>Shortlist target (optional)</label>
            <input
              type="number" min={1} value={editShortlistTarget}
              onChange={(e) => setEditShortlistTarget(e.target.value)}
              placeholder="leave blank for unlimited"
            />
          </div>
          <div className="field">
  <label>When the target is reached</label>
  <select value={editOnTargetReached} onChange={(e) => setEditOnTargetReached(e.target.value)}>
    <option value="pause">Pause — stop new applications, notify me right away</option>
    <option value="collect">Keep collecting — build a larger pool, I'll decide when to stop</option>
  </select>
</div>


          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn" onClick={() => handleSaveEdit(job.id)} disabled={busy}>
              {busy ? "Saving..." : "Save changes"}
            </button>
            <button
              style={{ padding: "11px 20px", fontSize: 14, background: "transparent", border: "1px solid var(--panel-border)", color: "var(--text)", borderRadius: 6, cursor: "pointer" }}
              onClick={() => setEditingId(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }

    const report = isReporting ? buildReport(job.id) : null;

    return (
      <div key={job.id} className="run">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="name">{job.title}</span>
          <span className="method">{job.status?.toUpperCase() ?? "OPEN"}</span>
        </div>
        <p className="msg" style={{ marginTop: 6 }}>
          {job.shortlistTarget != null ? `Shortlist target: ${job.shortlistTarget}` : "No shortlist target set"}
        </p>

        {isReporting && report && (
          <div style={{ marginTop: 10, borderTop: "1px solid var(--panel-border)", paddingTop: 10 }}>
            <p className="msg">Total applications: <span style={{ color: "var(--text)" }}>{report.total}</span></p>
            <p className="msg">Shortlisted: <span className="score high">{report.shortlisted}</span></p>
            <p className="msg">Rejected: <span className="score low">{report.rejected}</span></p>
            <p className="msg">Invited: <span className="score high">{report.invited}</span></p>
            <p className="msg">Awaiting screening: <span className="score mid">{report.received}</span></p>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button className="btn" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => startEdit(job)}>
            Edit
          </button>
          
          {job.status !== "open" && (
    <button
      style={{ padding: "6px 14px", fontSize: 12, background: "transparent", border: "1px solid var(--panel-border)", color: "var(--text)", borderRadius: 6, cursor: "pointer" }}
      onClick={() => handleReopen(job.id)} disabled={busy}
    >
      Reopen
    </button>
  )}

          
          <button
            style={{ padding: "6px 14px", fontSize: 12, background: "transparent", border: "1px solid var(--panel-border)", color: "var(--text)", borderRadius: 6, cursor: "pointer" }}
            onClick={() => setReportJobId(isReporting ? null : job.id)}
          >
            {isReporting ? "Hide report" : "Report"}
          </button>
          <button
            style={{ padding: "6px 14px", fontSize: 12, background: "transparent", border: "1px solid var(--panel-border)", color: "var(--text)", borderRadius: 6, cursor: "pointer" }}
            onClick={() => handleArchive(job.id)} disabled={busy}
          >
            {job.archived ? "Unarchive" : "Archive"}
          </button>
          {confirmingDeleteId === job.id ? (
            <>
              <button
                style={{ padding: "6px 14px", fontSize: 12, background: "var(--red)", color: "#1A0404", border: "none", borderRadius: 6, cursor: "pointer" }}
                onClick={() => handleDelete(job.id)} disabled={busy}
              >
                Confirm delete
              </button>
              <button
                style={{ padding: "6px 14px", fontSize: 12, background: "transparent", border: "1px solid var(--panel-border)", color: "var(--text)", borderRadius: 6, cursor: "pointer" }}
                onClick={() => setConfirmingDeleteId(null)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              style={{ padding: "6px 14px", fontSize: 12, background: "transparent", border: "1px solid var(--red)", color: "var(--red)", borderRadius: 6, cursor: "pointer" }}
              onClick={() => setConfirmingDeleteId(job.id)}
            >
              Delete
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="panel">
      <h2>Manage jobs</h2>
      <p className="desc">Edit, archive, delete, or view a quick report for any posted role.</p>
      {activeJobs.length === 0 && <p className="msg">No jobs posted yet.</p>}
      {activeJobs.map(renderJobRow)}

      {archivedJobs.length > 0 && (
        <>
          <h2 style={{ marginTop: 24 }}>Archived</h2>
          {archivedJobs.map(renderJobRow)}
        </>
      )}
    </div>
  );
}

// Root component — owns the tab state and the three data lists (jobs,
// applications, jobs pending HR review) that the tabs read from or write to.
export default function App() {
  const [tab, setTab] = useState<"careers" | "quick" | "guided" | "pipeline" | "post" | "review" | "manage">("careers");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [preselectedJobId, setPreselectedJobId] = useState<number | null>(null);
  const [pendingReviewJobs, setPendingReviewJobs] = useState<Job[]>([]);

  const loadJobs = () => fetch(`${API_URL}/jobs`).then((res) => res.json()).then(setJobs);
  const loadApplications = () => fetch(`${API_URL}/applications`).then((res) => res.json()).then(setApplications);
  const loadPendingReview = () =>
    fetch(`${API_URL}/jobs/pending-review`).then((res) => res.json()).then(setPendingReviewJobs);


  // A new application can immediately push a job into "needs review" (if it
// gets shortlisted and hits the target), so submitting one must refresh
// both the applications list AND the pending-review list — not just one.
const handleApplicationSubmitted = () => {
  loadApplications();
  loadPendingReview();
};
  useEffect(() => {
    loadJobs();
    loadApplications();
    loadPendingReview();
  }, []);

  const handleApplyFromCareers = (jobId: number, path: "quick" | "guided") => {
    setPreselectedJobId(jobId);
    setTab(path);
  };

  const handleReviewDecided = () => {
    loadPendingReview();
    loadJobs();
    loadApplications();
  };

  const handleManageChanged = () => {
    loadJobs();
    loadApplications();
    loadPendingReview();
  };

  return (
    <div className="shell">
      <div className="brand">
        <h1>Cruwo</h1>
        <span className="tag">AGENT-DRIVEN</span>
      </div>
      <p className="subhead">Hiring, run as a pipeline. Two ways in, one agent scoring everyone the same way.</p>

      <div className="tabs">
        <button className={`tab ${tab === "careers" ? "active" : ""}`} onClick={() => setTab("careers")}>Careers</button>
        <button className={`tab ${tab === "quick" ? "active" : ""}`} onClick={() => setTab("quick")}>Quick Apply</button>
        <button className={`tab ${tab === "guided" ? "active" : ""}`} onClick={() => setTab("guided")}>Guided Application</button>
        <button className={`tab ${tab === "pipeline" ? "active" : ""}`} onClick={() => setTab("pipeline")}>Pipeline</button>
       <button className={`tab ${tab === "review" ? "active" : ""}`} onClick={() => setTab("review")}>
  Review{pendingReviewJobs.length > 0 ? ` (${pendingReviewJobs.length})` : ""}
</button>
        <button className={`tab ${tab === "manage" ? "active" : ""}`} onClick={() => setTab("manage")}>Manage Jobs</button>
        <button className={`tab ${tab === "post" ? "active" : ""}`} onClick={() => setTab("post")}>Post a Job</button>
      </div>

      {tab === "careers" && <Careers jobs={jobs} onApply={handleApplyFromCareers} />}
      {tab === "quick" && <QuickApplyForm jobs={jobs} onSubmitted={handleApplicationSubmitted} preselectedJobId={preselectedJobId} />}
{tab === "guided" && <GuidedApplyForm jobs={jobs} onSubmitted={handleApplicationSubmitted} preselectedJobId={preselectedJobId} />}      
{tab === "pipeline" && <Pipeline applications={applications} onChanged={handleApplicationSubmitted} />}
      {tab === "review" && <Review pendingJobs={pendingReviewJobs} onDecided={handleReviewDecided} />}
      {tab === "manage" && <ManageJobs jobs={jobs} applications={applications} onChanged={handleManageChanged} />}
      {tab === "post" && <CreateJobForm onCreated={loadJobs} />}
    </div>
  );
}
