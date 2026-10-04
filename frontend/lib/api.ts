/**
 * Typed client for the Padawan backend. One module, no dependencies.
 * Frames go straight from the browser to the backend (never via a Next.js route).
 * Set NEXT_PUBLIC_API_MOCK=1 to get realistic fake data with no backend.
 */

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/+$/, "");
export const MOCK = process.env.NEXT_PUBLIC_API_MOCK === "1";

import { AUTH_MODE, supabase } from "./supabase";
import { seedSkills } from "./skills-mock";
import { detailFromSkill, skillToMarkdown, toSummary, type SkillDetail, type SkillSummary } from "./skills";
import { newUuid } from "./capture-sync";
import { findGaps, segmentEvents, synthesizeMockSkill, type MockAnswer, type MockQuestion } from "./mock-pipeline";
import type {
  AnswerBody, FinishResult, QuestionAskedBody, QuestionCandidate, StepDraft, StepUpdate, TeachbackResult, UtteranceIn,
} from "./pipeline-types";

export type { SkillDetail, SkillSummary, SkillJson, SkillStep, SkillGuardrail } from "./skills";
export type * from "./pipeline-types";

const TOKEN_KEY = "padawan_token";
const USER_KEY = "padawan_user";
const MOCK_KEY = "padawan_mock_sessions";

// ---------- types ----------

export type PadawanEvent = {
  id: number;
  kind: string;
  summary: string;
  entities: Record<string, string>;
  visible_text: string[];
  salient: boolean;
  confidence: number;
  t_ms?: number;
};

export type SkipReason = "busy" | "timeout" | "vision_error" | "parse_error" | "storage_error" | "off_the_record";

export type FrameResponse = {
  t_ms: number;
  screen_summary: string;
  events: PadawanEvent[];
  question_candidates: QuestionCandidate[];
  step_update: StepUpdate | null;
  latency_ms: number | null;
  skipped: SkipReason | null;
};

export type SessionSummary = {
  session_id: string;
  title: string;
  created_at: string;
  last_screen_summary: string | null;
  events_count: number;
};

export type SessionDetail = SessionSummary & { events: PadawanEvent[] };

export type TeachSession = {
  session_id: string;
  title: string;
  description: string;
  language: string;
  created_at: string;
};

export type LoginResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: { id: string; name: string };
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// ---------- token storage ----------

function hasStorage() {
  return typeof window !== "undefined";
}

export function getToken(): string | null {
  if (!hasStorage()) return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getUserName(): string | null {
  if (!hasStorage()) return null;
  try {
    return window.localStorage.getItem(USER_KEY);
  } catch {
    return null;
  }
}

function clearStored() {
  if (!hasStorage()) return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
  } catch {
    /* storage blocked: nothing to clear */
  }
}

/** Keeps the token where the rest of the app reads it (a sync read, see lib/use-token.ts). */
export function setSession(token: string, name: string) {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
    window.localStorage.setItem(USER_KEY, name);
  } catch {
    throw new ApiError(0, "Browser storage is blocked, cannot keep you signed in");
  }
}

/**
 * Supabase mode: make sure the stored token is the current one. supabase-js renews the access token
 * (valid about an hour) when it is about to expire, so asking it before each call is enough.
 */
export async function syncSupabaseToken(): Promise<void> {
  if (AUTH_MODE !== "supabase" || MOCK || !hasStorage()) return;
  const { data } = await supabase().auth.getSession();
  const session = data.session;
  if (session) setSession(session.access_token, session.user.email ?? "User");
  else clearStored();
}

/** Email and password sign-in with Supabase Auth. Accounts are created by the team in the Supabase dashboard. */
export async function loginWithSupabase(email: string, password: string): Promise<void> {
  const { data, error } = await supabase().auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new ApiError(401, error?.message ?? "Sign in failed");
  setSession(data.session.access_token, data.session.user.email ?? email);
}

/**
 * Creates an account with email and password. Supabase sends a confirmation email; the link opens the site
 * (see components/auth-sync.tsx) and signs the person in. Returns "signed_in" when confirmation is switched off.
 */
export async function signUpWithSupabase(email: string, password: string): Promise<"confirm_email" | "signed_in"> {
  const { data, error } = await supabase().auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw new ApiError(error.status ?? 400, error.message);
  if (data.session) {
    setSession(data.session.access_token, data.session.user.email ?? email);
    return "signed_in";
  }
  return "confirm_email";
}

/** Clears the stored session. Pass redirectTo to also leave the page (hard navigation). */
export function logout(redirectTo?: string) {
  if (!hasStorage()) return;
  if (AUTH_MODE === "supabase" && !MOCK) void supabase().auth.signOut();
  clearStored();
  if (redirectTo) window.location.assign(redirectTo);
}

function handleUnauthorized() {
  logout("/login");
}

// ---------- low-level request ----------

async function request<T>(path: string, init: RequestInit = {}, opts: { auth?: boolean; text?: boolean } = {}): Promise<T> {
  const auth = opts.auth !== false;
  const headers = new Headers(init.headers);
  if (auth) await syncSupabaseToken();
  const token = getToken();
  if (auth && token) headers.set("Authorization", `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, `Cannot reach the API at ${API_URL}`);
  }

  if (!res.ok) {
    let detail = res.statusText || `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
      else if (body?.detail && typeof body.detail === "object") {
        // e.g. 502 {"detail": {"error": "synthesis_failed", "problems": ["..."]}}
        const d = body.detail as { error?: unknown; problems?: unknown };
        const problems = Array.isArray(d.problems) ? d.problems.filter((p): p is string => typeof p === "string") : [];
        if (typeof d.error === "string") detail = problems.length ? `${d.error}: ${problems.join("; ")}` : d.error;
      }
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401 && auth) handleUnauthorized();
    throw new ApiError(res.status, detail);
  }
  if (opts.text) return (await res.text()) as T;
  return (await res.json()) as T;
}

// ---------- mock data ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mockEvents(): PadawanEvent[] {
  return [
    {
      id: 1, kind: "navigate", salient: false, confidence: 0.9, t_ms: 1000,
      summary: "Opened invoice 4471 in SandboxERP",
      entities: { app: "SandboxERP", invoice: "4471" }, visible_text: ["Invoice 4471"],
    },
    {
      id: 2, kind: "change", salient: true, confidence: 0.95, t_ms: 4000,
      summary: "Cost center field changed from 4711 to 0400",
      entities: { field: "cost center", from: "4711", to: "0400" }, visible_text: [],
    },
    {
      id: 3, kind: "input", salient: false, confidence: 0.82, t_ms: 7000,
      summary: "Typed an asset number into the asset field",
      entities: { field: "asset no." }, visible_text: [],
    },
    {
      id: 4, kind: "click", salient: true, confidence: 0.88, t_ms: 11000,
      summary: "Clicked Post, a confirmation dialog appeared",
      entities: { button: "Post" }, visible_text: ["Confirm posting?"],
    },
  ];
}

type MockSession = SessionDetail;

function mockStore(): MockSession[] {
  const g = globalThis as unknown as { __padawanMock?: MockSession[] };
  if (!g.__padawanMock && hasStorage()) {
    try {
      const raw = window.localStorage.getItem(MOCK_KEY);
      if (raw) g.__padawanMock = JSON.parse(raw) as MockSession[];
    } catch {
      /* ignore corrupt mock data */
    }
  }
  if (!g.__padawanMock) {
    const now = Date.now();
    const ev = mockEvents();
    g.__padawanMock = [
      {
        session_id: "mock-session-1", title: "Process supplier invoices",
        created_at: new Date(now - 3_600_000).toISOString(),
        last_screen_summary: "SandboxERP: invoice 4471 posted, cost center 0400, asset no. 10023",
        events_count: ev.length, events: ev,
      },
      {
        session_id: "mock-session-2", title: "Onboard a new vendor",
        created_at: new Date(now - 86_400_000).toISOString(),
        last_screen_summary: "Vendor form, tax ID field empty",
        events_count: 2, events: ev.slice(0, 2),
      },
    ];
  }
  return g.__padawanMock;
}

function mockSave() {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(MOCK_KEY, JSON.stringify(mockStore()));
  } catch {
    /* ignore */
  }
}

function mockRequireToken() {
  if (!getToken()) {
    handleUnauthorized();
    throw new ApiError(401, "Not authenticated");
  }
}

// ---------- public API ----------

export async function health(): Promise<{ status: string }> {
  if (MOCK) {
    await sleep(150);
    return { status: "ok" };
  }
  return request("/health", {}, { auth: false });
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  let data: LoginResponse;
  if (MOCK) {
    await sleep(300);
    if (username !== "admin" || password !== "admin") throw new ApiError(401, "invalid credentials");
    data = {
      access_token: "mock-token", token_type: "bearer", expires_in: 43200,
      user: { id: "admin", name: "Admin" },
    };
  } else {
    data = await request<LoginResponse>(
      "/v1/auth/login",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) },
      { auth: false },
    );
  }
  setSession(data.access_token, data.user.name);
  return data;
}

export async function createTeachSession(title = "New task", description = "", language = "en"): Promise<TeachSession> {
  if (MOCK) {
    await sleep(250);
    mockRequireToken();
    const s: MockSession = {
      session_id: `mock-${Math.random().toString(36).slice(2, 8)}`, title,
      created_at: new Date().toISOString(), last_screen_summary: null, events_count: 0, events: [],
    };
    mockStore().unshift(s);
    mockSave();
    return { session_id: s.session_id, title, description, language, created_at: s.created_at };
  }
  return request("/v1/teach/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, description, language }),
  });
}

export async function listSessions(): Promise<SessionSummary[]> {
  if (MOCK) {
    await sleep(250);
    mockRequireToken();
    return mockStore().map(({ events, ...summary }) => (void events, summary));
  }
  return request("/v1/sessions");
}

export async function getSession(id: string): Promise<SessionDetail> {
  if (MOCK) {
    await sleep(150);
    mockRequireToken();
    const s = mockStore().find((x) => x.session_id === id);
    if (!s) throw new ApiError(404, "session not found");
    return { ...s };
  }
  return request(`/v1/sessions/${encodeURIComponent(id)}`);
}

export async function sendFrame(sessionId: string, tMs: number, frame: Blob): Promise<FrameResponse> {
  if (MOCK) {
    await sleep(600);
    mockRequireToken();
    const s = mockStore().find((x) => x.session_id === sessionId);
    if (!s) throw new ApiError(404, "session not found");
    const next = mockEvents()[s.events.length % 4];
    const ev: PadawanEvent = { ...next, id: s.events.length + 1, t_ms: tMs };
    s.events.push(ev);
    s.events_count = s.events.length;
    s.last_screen_summary = `Mock screen after: ${ev.summary}`;
    mockSave();
    const { t_ms, ...rest } = ev;
    void t_ms;
    const pipe = mockPipeline(sessionId);
    const steps = segmentEvents(s.events, pipe.questions, false);
    const last = steps[steps.length - 1];
    const candidates: QuestionCandidate[] = ev.salient
      ? [{ id: newUuid(), type: ev.kind === "click" ? "guardrail" : "reason", text: mockCandidateText(ev), anchor_event_id: ev.id, priority: 0.9 }]
      : [];
    return {
      t_ms: tMs, screen_summary: s.last_screen_summary, events: [rest],
      question_candidates: candidates,
      step_update: last ? { idx: last.idx, title: last.title, status: last.status } : null,
      latency_ms: 600, skipped: null,
    };
  }
  const form = new FormData();
  form.append("t_ms", String(Math.round(tMs)));
  form.append("frame", frame, "frame.jpg");
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}/frames`, { method: "POST", body: form });
}

function mockCandidateText(ev: PadawanEvent): string {
  const e = ev.entities ?? {};
  if (e.field && e.from && e.to) return `Why did you change the ${e.field} from ${e.from} to ${e.to}?`;
  if (e.button) return `Why ${e.button.toLowerCase()} now, and what would make you hold off?`;
  return `Why did you do this: ${ev.summary.replace(/[.?!]+$/, "")}?`;
}

// ---------- skills pipeline: transcript, questions, steps, finish, teach-back ----------
// Real contract (backend/app/routers/capture.py, docs/frontend-integration.md section 3b). None of these run per frame.

type MockPipeline = {
  questions: MockQuestion[];
  answers: MockAnswer[];
  utterances: UtteranceIn[];
  skillId: string | null;
};
const MOCK_PIPE_KEY = "padawan_mock_pipeline";

function mockPipelines(): Record<string, MockPipeline> {
  const g = globalThis as unknown as { __padawanMockPipe?: Record<string, MockPipeline> };
  if (!g.__padawanMockPipe && hasStorage()) {
    try {
      const raw = window.localStorage.getItem(MOCK_PIPE_KEY);
      if (raw) g.__padawanMockPipe = JSON.parse(raw) as Record<string, MockPipeline>;
    } catch {
      /* ignore corrupt mock data */
    }
  }
  if (!g.__padawanMockPipe) g.__padawanMockPipe = {};
  return g.__padawanMockPipe;
}

function mockPipeline(sessionId: string): MockPipeline {
  const all = mockPipelines();
  return (all[sessionId] ??= { questions: [], answers: [], utterances: [], skillId: null });
}

function mockPipeSave() {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(MOCK_PIPE_KEY, JSON.stringify(mockPipelines()));
  } catch {
    /* ignore */
  }
}

function mockSessionOrThrow(sessionId: string): MockSession {
  mockRequireToken();
  const s = mockStore().find((x) => x.session_id === sessionId);
  if (!s) throw new ApiError(404, "session not found");
  return s;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const sid = (id: string) => encodeURIComponent(id);

/** Stores transcript lines (1 to 200). */
export async function postUtterances(sessionId: string, utterances: UtteranceIn[]): Promise<{ stored: number; ids: number[] }> {
  if (MOCK) {
    await sleep(80);
    mockSessionOrThrow(sessionId);
    const pipe = mockPipeline(sessionId);
    pipe.utterances.push(...utterances);
    mockPipeSave();
    return { stored: utterances.length, ids: utterances.map((_, i) => pipe.utterances.length - utterances.length + i + 1) };
  }
  return request(`/v1/sessions/${sid(sessionId)}/utterances`, post({ utterances }));
}

/** Records that a question was asked (the candidate id from the frame response, or a client UUID). Idempotent per id. */
export async function postQuestionAsked(sessionId: string, questionId: string, body: QuestionAskedBody): Promise<void> {
  if (MOCK) {
    await sleep(80);
    mockSessionOrThrow(sessionId);
    const pipe = mockPipeline(sessionId);
    const row: MockQuestion = {
      id: questionId, type: body.type ?? "reason", text: body.text, anchor_event_id: body.anchor_event_id ?? null,
      phase: body.phase ?? "live", answered: false,
    };
    const i = pipe.questions.findIndex((q) => q.id === questionId);
    if (i >= 0) pipe.questions[i] = { ...row, answered: pipe.questions[i].answered };
    else pipe.questions.push(row);
    mockPipeSave();
    return;
  }
  await request(`/v1/sessions/${sid(sessionId)}/questions/${encodeURIComponent(questionId)}/asked`, post(body));
}

/** The expert's answer to a question that was recorded with postQuestionAsked. 404 if it never was. */
export async function postAnswer(sessionId: string, body: AnswerBody): Promise<{ question_id: string; utterance_id: number }> {
  if (MOCK) {
    await sleep(80);
    mockSessionOrThrow(sessionId);
    const pipe = mockPipeline(sessionId);
    const q = pipe.questions.find((x) => x.id === body.question_id);
    if (!q) throw new ApiError(404, "question not found");
    q.answered = true;
    pipe.answers.push({ question_id: body.question_id, quote: body.quote, summary: body.summary ?? "" });
    pipe.utterances.push({ t_ms: body.t_ms ?? 0, speaker: "expert", text: body.quote });
    mockPipeSave();
    return { question_id: body.question_id, utterance_id: pipe.utterances.length };
  }
  return request(`/v1/sessions/${sid(sessionId)}/answers`, post(body));
}

/** The steps built so far. */
export async function getSteps(sessionId: string): Promise<StepDraft[]> {
  if (MOCK) {
    await sleep(100);
    const s = mockSessionOrThrow(sessionId);
    return segmentEvents(s.events, mockPipeline(sessionId).questions, false);
  }
  const r = await request<{ steps: StepDraft[] }>(`/v1/sessions/${sid(sessionId)}/steps`);
  return r.steps;
}

/** Closes the steps, computes the gaps for the debrief. */
export async function finishSession(sessionId: string): Promise<FinishResult> {
  if (MOCK) {
    await sleep(500);
    const s = mockSessionOrThrow(sessionId);
    const steps = segmentEvents(s.events, mockPipeline(sessionId).questions, true);
    return { session_id: sessionId, status: "debrief", steps, gaps: findGaps(steps, s.events) };
  }
  return request(`/v1/sessions/${sid(sessionId)}/finish`, { method: "POST" });
}

/** Runs the synthesis (3 to 30 s) and returns the new draft skill. 400 if not confirmed, 409 if nothing was captured. */
export async function postTeachback(sessionId: string, confirmed: boolean, corrections: string[]): Promise<TeachbackResult> {
  if (MOCK) {
    await sleep(1800);
    const s = mockSessionOrThrow(sessionId);
    if (!confirmed) throw new ApiError(400, "the teach-back must be confirmed");
    const pipe = mockPipeline(sessionId);
    const steps = segmentEvents(s.events, pipe.questions, true);
    if (steps.length === 0) throw new ApiError(409, "this session captured nothing yet");
    const id = pipe.skillId ?? `skill-${newUuid().slice(0, 8)}`;
    const json = synthesizeMockSkill({
      id, title: s.title, author: { id: "admin", name: getUserName() ?? "Admin" }, steps, events: s.events,
      questions: pipe.questions, answers: pipe.answers, corrections, now: new Date().toISOString(),
    });
    const list = mockSkills();
    const old = list.findIndex((x) => x.id === id);
    const keep = old >= 0 ? list[old] : null;
    const detail = detailFromSkill(json, {
      status: keep?.status ?? "draft", domain: keep?.domain ?? null, published_at: keep?.published_at ?? null,
    });
    if (old >= 0) list[old] = detail;
    else list.unshift(detail);
    pipe.skillId = id;
    mockSkillsSave();
    mockPipeSave();
    return { skill_id: id, status: "draft", steps_count: detail.steps_count, guardrails_count: detail.guardrails_count, attempts: 1 };
  }
  return request(`/v1/sessions/${sid(sessionId)}/teachback`, post({ confirmed, corrections }));
}

/** Off the record: the backend stops analysing and storing frames until it is switched off again. */
export async function setOffTheRecord(sessionId: string, on: boolean): Promise<void> {
  if (MOCK) {
    await sleep(50);
    mockSessionOrThrow(sessionId);
    return;
  }
  await request(`/v1/sessions/${sid(sessionId)}/off-the-record`, post({ on }));
}

// ---------- skills (Holocrons) ----------
// Real contract (backend/app/routers/skills.py):
//   GET  /v1/skills?q=&domain=&mine=   -> SkillSummary[]  (published ones, or with mine=true your own incl. drafts)
//   GET  /v1/skills/{id}               -> SkillDetail = SkillSummary + skill (JSON or null) + skill_md
//   POST /v1/skills/{id}/publish       -> SkillDetail (author only; 409 without steps)
//   GET  /v1/skills/{id}/export        -> SKILL.md as text/markdown

const MOCK_SKILLS_KEY = "padawan_mock_skills";

function mockSkills(): SkillDetail[] {
  const g = globalThis as unknown as { __padawanMockSkills?: SkillDetail[] };
  if (!g.__padawanMockSkills && hasStorage()) {
    try {
      const raw = window.localStorage.getItem(MOCK_SKILLS_KEY);
      if (raw) g.__padawanMockSkills = JSON.parse(raw) as SkillDetail[];
    } catch {
      /* ignore corrupt mock data */
    }
  }
  if (!g.__padawanMockSkills) g.__padawanMockSkills = seedSkills();
  return g.__padawanMockSkills;
}

function mockSkillsSave() {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(MOCK_SKILLS_KEY, JSON.stringify(mockSkills()));
  } catch {
    /* ignore */
  }
}

function mockFindSkill(id: string): SkillDetail {
  const s = mockSkills().find((x) => x.id === id);
  if (!s) throw new ApiError(404, "skill not found");
  return s;
}

export type SkillQuery = { q?: string; domain?: string; mine?: boolean };

export async function listSkills({ q, domain, mine }: SkillQuery = {}): Promise<SkillSummary[]> {
  if (MOCK) {
    await sleep(250);
    mockRequireToken();
    const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    return mockSkills()
      .filter((s) => (mine ? s.author.id === "admin" : s.status === "published"))
      .filter((s) => !domain || s.domain === domain)
      .filter((s) => words.every((w) => `${s.title} ${s.description}`.toLowerCase().includes(w)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(toSummary);
  }
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (domain) params.set("domain", domain);
  if (mine) params.set("mine", "true");
  const qs = params.toString();
  return request(`/v1/skills${qs ? `?${qs}` : ""}`);
}

export async function getSkill(id: string): Promise<SkillDetail> {
  if (MOCK) {
    await sleep(150);
    mockRequireToken();
    return structuredClone(mockFindSkill(id));
  }
  return request(`/v1/skills/${encodeURIComponent(id)}`);
}

export async function publishSkill(id: string): Promise<SkillDetail> {
  if (MOCK) {
    await sleep(300);
    mockRequireToken();
    const s = mockFindSkill(id);
    if (s.status !== "published") {
      if (!s.skill || s.steps_count < 1) throw new ApiError(409, "this skill has no steps yet: finish the teach-back first");
      s.status = "published";
      s.published_at = new Date().toISOString();
      mockSkillsSave();
    }
    return structuredClone(s);
  }
  return request(`/v1/skills/${encodeURIComponent(id)}/publish`, { method: "POST" });
}

/** SKILL.md text for a skill (what an agent loads). */
export async function exportSkill(id: string): Promise<string> {
  if (MOCK) {
    await sleep(150);
    mockRequireToken();
    const found = mockFindSkill(id);
    if (!found.skill) throw new ApiError(404, "this skill has no SKILL.md yet");
    return found.skill_md ?? skillToMarkdown(found.skill);
  }
  return request(`/v1/skills/${encodeURIComponent(id)}/export`, {}, { text: true });
}

// ---------- voice (Yoda) ----------

export type VoiceMode = "capture" | "debrief" | "tutor";

export type VoiceSession = {
  signed_url: string;
  agent_id: string;
  dynamic_variables: Record<string, string | number | boolean>;
};

/** Asks the backend for a short-lived signed URL to talk to Yoda (never the ElevenLabs key). One per conversation. */
export async function startVoiceSession(sessionId: string, mode: VoiceMode, pendingQuestion = ""): Promise<VoiceSession> {
  if (MOCK) {
    await sleep(300);
    mockRequireToken();
    return {
      signed_url: "wss://mock.invalid/voice",
      agent_id: "mock-agent",
      dynamic_variables: { mode: mode === "capture" ? "live" : mode, task_title: "Mock task", gaps: "", last_screen_summary: "", pending_question: pendingQuestion },
    };
  }
  return request("/v1/voice/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, mode, pending_question: pendingQuestion }),
  });
}
