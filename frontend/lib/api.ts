/**
 * Typed client for the Padawan backend. One module, no dependencies.
 * Frames go straight from the browser to the backend (never via a Next.js route).
 * Set NEXT_PUBLIC_API_MOCK=1 to get realistic fake data with no backend.
 */

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/+$/, "");
export const MOCK = process.env.NEXT_PUBLIC_API_MOCK === "1";

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

export type SkipReason = "busy" | "timeout" | "vision_error" | "parse_error" | "storage_error";

export type FrameResponse = {
  t_ms: number;
  screen_summary: string;
  events: PadawanEvent[];
  question_candidates: unknown[];
  step_update: unknown | null;
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

/** Clears the stored session. Pass redirectTo to also leave the page (hard navigation). */
export function logout(redirectTo?: string) {
  if (!hasStorage()) return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
  } catch {
    /* storage blocked: nothing to clear */
  }
  if (redirectTo) window.location.assign(redirectTo);
}

function handleUnauthorized() {
  logout("/login");
}

// ---------- low-level request ----------

async function request<T>(path: string, init: RequestInit = {}, opts: { auth?: boolean } = {}): Promise<T> {
  const auth = opts.auth !== false;
  const headers = new Headers(init.headers);
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
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401 && auth) handleUnauthorized();
    throw new ApiError(res.status, detail);
  }
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
  try {
    window.localStorage.setItem(TOKEN_KEY, data.access_token);
    window.localStorage.setItem(USER_KEY, data.user.name);
  } catch {
    throw new ApiError(0, "Browser storage is blocked, cannot keep you signed in");
  }
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
    return {
      t_ms: tMs, screen_summary: s.last_screen_summary, events: [rest],
      question_candidates: [], step_update: null, latency_ms: 600, skipped: null,
    };
  }
  const form = new FormData();
  form.append("t_ms", String(Math.round(tMs)));
  form.append("frame", frame, "frame.jpg");
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}/frames`, { method: "POST", body: form });
}
