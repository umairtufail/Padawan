/**
 * Client for the learn endpoints (docs/frontend-integration.md section 10). With NEXT_PUBLIC_API_MOCK=1 the whole
 * flow runs on scripted data (lib/learn-mock.ts), so it works without a backend.
 */
import { ApiError, MOCK, getSkill, getToken, logout, mockRecordLearner, request } from "./api";
import { sortSessions, type LearnSessionRow } from "./learning";
import { stepById, type LearnFrameResponse, type LearnSessionOut, type MasteryReport, type PredictionOut } from "./learn";
import { buildReport, judgePrediction, mockSummary, newMockLearn, recordVerdict, scriptedVerdict, type MockLearn } from "./learn-mock";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = { "Content-Type": "application/json" };
const enc = encodeURIComponent;

function mockStore(): Map<string, MockLearn> {
  const g = globalThis as unknown as { __padawanMockLearn?: Map<string, MockLearn> };
  return (g.__padawanMockLearn ??= new Map());
}

function mockSession(id: string): MockLearn {
  if (!getToken()) {
    logout("/login");
    throw new ApiError(401, "Not authenticated");
  }
  const m = mockStore().get(id);
  if (!m) throw new ApiError(404, "learn session not found");
  return m;
}

// ---------- mock "My learning" rows (kept in localStorage so they survive a reload) ----------

const MOCK_ROWS_KEY = "padawan_mock_learning_v1";
type MockRows = { rows: LearnSessionRow[]; reports: Record<string, MasteryReport> };

function seedRows(): LearnSessionRow[] {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  return [
    { session_id: "mock-learn-seed1", skill_id: "skill-invoices", skill_title: "Process supplier invoices before month-end", created_at: ago(2 * 86_400_000), finished: true, mastery_score: 74, steps_total: 5, steps_done: 5 },
    { session_id: "mock-learn-seed2", skill_id: "skill-vendor", skill_title: "Onboard a new vendor", created_at: ago(3_600_000), finished: false, mastery_score: null, steps_total: 3, steps_done: 1 },
  ];
}

function mockRows(): MockRows {
  const g = globalThis as unknown as { __padawanMockRows?: MockRows };
  if (g.__padawanMockRows) return g.__padawanMockRows;
  let data: MockRows | null = null;
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(MOCK_ROWS_KEY);
      if (raw) data = JSON.parse(raw) as MockRows;
    } catch {
      /* ignore corrupt mock data */
    }
  }
  return (g.__padawanMockRows = data ?? { rows: seedRows(), reports: {} });
}

function mockRowsSave() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MOCK_ROWS_KEY, JSON.stringify(mockRows()));
  } catch {
    /* ignore */
  }
}

/** GET /v1/learn/sessions: the signed-in user's own lessons, newest first. */
export async function listLearnSessions(): Promise<LearnSessionRow[]> {
  if (MOCK) {
    await sleep(250);
    if (!getToken()) {
      logout("/login");
      throw new ApiError(401, "Not authenticated");
    }
    return sortSessions(structuredClone(mockRows().rows));
  }
  return request("/v1/learn/sessions");
}

/** GET /v1/learn/sessions/{id}/report: reopen a lesson's mastery report (does not end the session). */
export async function getLearnReport(sessionId: string): Promise<MasteryReport> {
  if (MOCK) {
    await sleep(250);
    if (!getToken()) {
      logout("/login");
      throw new ApiError(401, "Not authenticated");
    }
    const data = mockRows();
    const stored = data.reports[sessionId];
    if (stored) return structuredClone(stored);
    const row = data.rows.find((r) => r.session_id === sessionId);
    if (!row?.skill_id) throw new ApiError(404, "learn session not found");
    const skill = (await getSkill(row.skill_id)).skill;
    if (!skill) throw new ApiError(404, "learn session not found");
    // A seeded session: rebuild a plausible report from the skill (everything reached, one stop on a guarded step).
    const m = newMockLearn(skill);
    skill.steps.slice(0, row.steps_done).forEach((s) => m.reached.add(s.idx));
    const guarded = skill.steps.find((s) => s.guardrails.length > 0);
    if (guarded && row.finished) m.stops.set(guarded.idx, 1);
    const base = buildReport(m, sessionId, "");
    return { ...base, mastery_score: row.mastery_score ?? base.mastery_score, summary: mockSummary(base) };
  }
  return request(`/v1/learn/sessions/${enc(sessionId)}/report`);
}

export async function createLearnSession(skillId: string): Promise<LearnSessionOut> {
  if (MOCK) {
    await sleep(250);
    const skill = (await getSkill(skillId)).skill;
    if (!skill || skill.steps.length === 0) throw new ApiError(409, "this skill has no steps");
    const id = `mock-learn-${Math.random().toString(36).slice(2, 8)}`;
    const m = newMockLearn(skill);
    mockStore().set(id, m);
    mockRows().rows.unshift({
      session_id: id, skill_id: skill.id, skill_title: skill.title, created_at: new Date().toISOString(), finished: false,
      mastery_score: null, steps_total: skill.steps.length, steps_done: 0,
    });
    mockRowsSave();
    mockRecordLearner(skill.id, { started: true });
    return { session_id: id, skill_id: skill.id, title: skill.title, created_at: new Date().toISOString(), current_step_idx: m.currentIdx, skill };
  }
  return request("/v1/learn/sessions", { method: "POST", headers: json, body: JSON.stringify({ skill_id: skillId }) });
}

export async function sendLearnFrame(sessionId: string, tMs: number, frame: Blob): Promise<LearnFrameResponse> {
  if (MOCK) {
    await sleep(700);
    const m = mockSession(sessionId);
    m.frames += 1;
    const verdict = scriptedVerdict(m, m.frames);
    recordVerdict(m, verdict, tMs);
    const row = mockRows().rows.find((r) => r.session_id === sessionId);
    if (row) {
      row.steps_done = m.reached.size;
      mockRowsSave();
    }
    return {
      t_ms: tMs, screen_summary: `Mock screen, frame ${m.frames}: ${verdict.step_title}`, events: [], question_candidates: [],
      step_update: null, latency_ms: 700, skipped: null, verdict,
    };
  }
  const form = new FormData();
  form.append("t_ms", String(Math.round(tMs)));
  form.append("frame", frame, "frame.jpg");
  return request(`/v1/learn/sessions/${enc(sessionId)}/frames`, { method: "POST", body: form });
}

/** What the tutor tool record_prediction does: stores the prediction and compares it at once. */
export async function recordPrediction(sessionId: string, stepIdx: number, predicted: string): Promise<PredictionOut> {
  if (MOCK) {
    await sleep(300);
    const m = mockSession(sessionId);
    const step = stepById(m.skill, stepIdx);
    if (!step || !predicted.trim()) throw new ApiError(422, "unknown step or empty prediction");
    const correct = judgePrediction(predicted, step.decision.summary);
    m.predictions.set(stepIdx, { predicted, correct });
    const replay = { step_idx: step.idx, t_ms: step.screen_moment.t_ms, description: step.screen_moment.description, keyframe_path: null };
    return {
      step_idx: stepIdx, predicted, resolved: true,
      result: { step_idx: stepIdx, predicted, correct, judged_by: "heuristic", expected: step.decision.summary, reason: step.reason?.text ?? null, reason_quote: step.reason?.quote ?? null, replay },
    };
  }
  return request(`/v1/learn/sessions/${enc(sessionId)}/predictions`, {
    method: "POST", headers: json, body: JSON.stringify({ step_idx: stepIdx, predicted, resolve: true }),
  });
}

/** Ends the session and returns the mastery report (with Yoda's summary). */
export async function finishLearning(sessionId: string): Promise<MasteryReport> {
  if (MOCK) {
    await sleep(500);
    const m = mockSession(sessionId);
    const base = buildReport(m, sessionId, "");
    const report = { ...base, summary: mockSummary(base) };
    const data = mockRows();
    const row = data.rows.find((r) => r.session_id === sessionId);
    if (row && !row.finished) {
      row.finished = true;
      row.mastery_score = report.mastery_score;
      row.steps_done = report.steps_reached;
      data.reports[sessionId] = report;
      mockRowsSave();
      mockRecordLearner(report.skill_id, { finished: report.mastery_score });
    }
    return report;
  }
  return request(`/v1/learn/sessions/${enc(sessionId)}/finish`, { method: "POST" });
}
