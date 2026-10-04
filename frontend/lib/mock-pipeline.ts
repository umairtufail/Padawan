/**
 * Pure stand-ins for the backend's skills pipeline, used by NEXT_PUBLIC_API_MOCK=1: the step segmenter, the gap
 * finder and the skill synthesizer. Deliberately simple (the real ones are model-driven), but they produce the
 * real response shapes so the whole capture -> debrief -> Holocron flow can be tested without a backend.
 */
import type { Gap, StepDraft } from "./pipeline-types";
import type { SkillJson, SkillStep } from "./skills";

export type MockEvent = { id: number; summary: string; salient: boolean; t_ms?: number; entities?: Record<string, string> };
export type MockQuestion = { id: string; type: string; text: string; anchor_event_id: number | null; phase: "live" | "debrief"; answered: boolean };
export type MockAnswer = { question_id: string; quote: string; summary: string };

/** A step ends after each salient event (a decision); events after the last one stay in an open step. */
export function segmentEvents(events: MockEvent[], questions: MockQuestion[], closeAll: boolean): StepDraft[] {
  const groups: MockEvent[][] = [];
  let cur: MockEvent[] = [];
  for (const e of events) {
    cur.push(e);
    if (e.salient) {
      groups.push(cur);
      cur = [];
    }
  }
  const trailing = cur.length > 0;
  if (trailing) groups.push(cur);
  return groups.map((g, i) => {
    const isOpen = trailing && i === groups.length - 1 && !closeAll;
    const decision = g.find((e) => e.salient) ?? g[g.length - 1];
    const ids = new Set(g.map((e) => e.id));
    const times = g.map((e) => e.t_ms).filter((t): t is number => typeof t === "number");
    return {
      idx: i + 1,
      title: shortTitle(decision.summary),
      t_start_ms: times.length ? Math.min(...times) : null,
      t_end_ms: times.length ? Math.max(...times) : null,
      event_ids: g.map((e) => e.id),
      question_ids: questions.filter((q) => q.phase === "live" && q.anchor_event_id !== null && ids.has(q.anchor_event_id)).map((q) => q.id),
      status: isOpen ? "open" : "closed",
    };
  });
}

function shortTitle(summary: string): string {
  const s = summary.replace(/[.?!]+$/, "").trim();
  return s.length > 70 ? `${s.slice(0, 69).trimEnd()}…` : s || "Untitled step";
}

/** Gaps for the debrief: steps without a reason or a guardrail, plus two session-wide questions. At least 3. */
export function findGaps(steps: StepDraft[], events: MockEvent[]): Gap[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const gaps: Gap[] = [];
  for (const s of steps) {
    const anchor = s.event_ids.find((id) => byId.get(id)?.salient) ?? s.event_ids[0] ?? null;
    if (s.question_ids.length === 0) {
      gaps.push({
        id: `gap-${gaps.length + 1}`, type: "missing_reason", step_idx: s.idx, anchor_event_id: anchor,
        text: `Why did you do this: ${s.title}?`, priority: 0.9 - gaps.length * 0.02,
      });
    }
    if (anchor !== null && byId.get(anchor)?.salient) {
      gaps.push({
        id: `gap-${gaps.length + 1}`, type: "missing_guardrail", step_idx: s.idx, anchor_event_id: anchor,
        text: `When would you stop and ask someone before "${s.title}"?`, priority: 0.8 - gaps.length * 0.02,
      });
    }
  }
  const extra: Omit<Gap, "id">[] = [
    { type: "unseen_case", text: "Is there a case you did not show me today, where this goes differently?", step_idx: null, anchor_event_id: null, priority: 0.4 },
    { type: "unclear_term", text: "Which term here would a new colleague not understand?", step_idx: null, anchor_event_id: null, priority: 0.3 },
    { type: "unasked_question", text: "What is the one mistake a Padawan makes most often with this task?", step_idx: null, anchor_event_id: null, priority: 0.2 },
  ];
  extra.forEach((e, k) => {
    if (k === 0 || gaps.length < 3) gaps.push({ ...e, id: `gap-${gaps.length + 1}` });
  });
  return gaps.sort((a, b) => b.priority - a.priority).slice(0, 12);
}

const PLACEHOLDER_TITLE = /^\s*(new task|untitled( task| session)?( \d+)?|task|skill|session|)\s*$/i;

/** Session titles start as "New task": a skill gets a real name (the backend asks the model; the mock uses the first steps). */
export function skillTitle(sessionTitle: string, steps: Pick<StepDraft, "title">[]): string {
  if (!PLACEHOLDER_TITLE.test(sessionTitle)) return sessionTitle.trim();
  const first = steps.map((s) => s.title.replace(/[.?!]+$/, "").trim()).filter(Boolean).slice(0, 2);
  const words = (first[0] ?? "").split(/\s+/).filter(Boolean);
  if (words.length < 3 && first[1]) words.push("/", ...first[1].split(/\s+/));
  return words.slice(0, 8).join(" ") || "Recorded task";
}

type SynthInput = {
  id: string;
  title: string;
  author: { id: string; name: string };
  steps: StepDraft[];
  events: MockEvent[];
  questions: MockQuestion[];
  answers: MockAnswer[];
  corrections: string[];
  now: string;
};

/** A draft skill from the steps and what the Master answered. Guardrail answers become guardrails. */
export function synthesizeMockSkill(i: SynthInput): SkillJson {
  const byId = new Map(i.events.map((e) => [e.id, e]));
  const answerOf = (qid: string) => i.answers.find((a) => a.question_id === qid);
  const steps: SkillStep[] = i.steps.map((s) => {
    const qs = i.questions.filter((q) => s.question_ids.includes(q.id) || (q.anchor_event_id !== null && s.event_ids.includes(q.anchor_event_id)));
    const reasonQ = qs.find((q) => q.type !== "guardrail" && answerOf(q.id));
    const reasonA = reasonQ ? answerOf(reasonQ.id) : undefined;
    const guardrails = qs
      .filter((q) => q.type === "guardrail" && answerOf(q.id))
      .map((q, gi) => {
        const a = answerOf(q.id)!;
        return { id: `g${s.idx}${gi + 1}`, type: "stop_and_ask", rule: a.summary || a.quote, quote: a.quote, t_ms: s.t_end_ms, source: "expert" as const };
      });
    const decision = s.event_ids.map((id) => byId.get(id)).find((e) => e?.salient);
    return {
      idx: s.idx,
      title: s.title,
      screen_moment: { t_ms: s.t_start_ms ?? 0, keyframe_path: null, description: byId.get(s.event_ids[0])?.summary ?? s.title },
      decision: { type: decision ? "judgment" : "routine", summary: decision?.summary ?? s.title },
      reason: reasonA ? { text: reasonA.summary || reasonA.quote, quote: reasonA.quote, t_ms: s.t_end_ms ?? 0 } : null,
      guardrails,
      predict_prompt: decision ? `What would you do here: ${s.title}?` : null,
    };
  });
  // Guardrails numbered across the whole skill (the backend guarantees unique ids).
  let n = 0;
  for (const st of steps) for (const g of st.guardrails) g.id = `g${++n}`;
  const correctionGuardrails = i.corrections.map((c) => ({
    id: `g${++n}`, type: "limit", rule: c, quote: "", t_ms: null, source: "teachback" as const,
  }));
  const title = skillTitle(i.title, i.steps);
  return {
    id: i.id, title, description: `Taught in the session "${title}" (mock synthesis, not a model).`,
    summary: `The Master walked through ${steps.length} ${steps.length === 1 ? "step" : "steps"}: ${steps.map((s) => s.title.replace(/[.?!]+$/, "")).join(", then ")}. (Mock summary, not a model.)`,
    author: i.author, created_at: i.now, language: "en", steps, global_guardrails: correctionGuardrails,
    teachback: { confirmed: true, corrections: i.corrections },
  };
}
