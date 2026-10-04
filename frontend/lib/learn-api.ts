/**
 * Client for the learn endpoints (docs/frontend-integration.md section 10). With NEXT_PUBLIC_API_MOCK=1 the whole
 * flow runs on scripted data (lib/learn-mock.ts), so it works without a backend.
 */
import { ApiError, MOCK, getSkill, getToken, logout, request } from "./api";
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

export async function createLearnSession(skillId: string): Promise<LearnSessionOut> {
  if (MOCK) {
    await sleep(250);
    const skill = (await getSkill(skillId)).skill;
    if (!skill || skill.steps.length === 0) throw new ApiError(409, "this skill has no steps");
    const id = `mock-learn-${Math.random().toString(36).slice(2, 8)}`;
    const m = newMockLearn(skill);
    mockStore().set(id, m);
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
    return { ...base, summary: mockSummary(base) };
  }
  return request(`/v1/learn/sessions/${enc(sessionId)}/finish`, { method: "POST" });
}
