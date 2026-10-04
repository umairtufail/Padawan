/**
 * Mock learn backend for NEXT_PUBLIC_API_MOCK=1: scripted verdicts (including one stop), a prediction judge and a
 * mastery report computed with the same formulas as the real backend. Pure functions, no browser or network code.
 */
import type { SkillJson } from "./skills";
import type { GuardrailVerdict, MasteryReport, PracticeItem, StepReport } from "./learn";

export type MockLearn = {
  skill: SkillJson;
  frames: number;
  currentIdx: number;
  reached: Set<number>;
  predictions: Map<number, { predicted: string; correct: boolean }>;
  stops: Map<number, number>;
  warns: Map<number, number>;
  timeMs: Map<number, number>;
  lastT: number;
};

const sorted = (skill: Pick<SkillJson, "steps">) => [...skill.steps].sort((a, b) => a.idx - b.idx);

export function newMockLearn(skill: SkillJson): MockLearn {
  const first = sorted(skill)[0]?.idx ?? 1;
  return {
    skill, frames: 0, currentIdx: first, reached: new Set([first]),
    predictions: new Map(), stops: new Map(), warns: new Map(), timeMs: new Map(), lastT: 0,
  };
}

const okVerdict = (step: number, title: string): GuardrailVerdict => ({
  verdict: "ok", checked: true, step_idx: step, step_title: title, guardrail_id: null, rule: "", expert_quote: "",
  reason: "", confidence: 0.9, committed: false, repeated: false, degraded: false, replay: null,
});

/**
 * The scripted run: frame 1 ok on the first step, frame 2 moves to the second, frame 3 a warning there, frame 4 a
 * STOP on the first later step that has a guardrail, frames 5-6 are unchecked, frame 7 clears it, then one step further per frame.
 */
export function scriptedVerdict(m: MockLearn, frameNo: number): GuardrailVerdict {
  const steps = sorted(m.skill);
  const at = (i: number) => steps[Math.min(Math.max(i, 0), steps.length - 1)];
  const stopStep = steps.slice(Math.min(2, steps.length - 1)).find((s) => s.guardrails.length > 0) ?? steps.find((s) => s.guardrails.length > 0) ?? at(steps.length - 1);
  const stopPos = steps.indexOf(stopStep);
  const moment = (s: (typeof steps)[number]) => ({ step_idx: s.idx, t_ms: s.screen_moment.t_ms, description: s.screen_moment.description, keyframe_path: null });

  if (frameNo <= 1) return okVerdict(at(0).idx, at(0).title);
  if (frameNo === 2) return okVerdict(at(1).idx, at(1).title);
  if (frameNo === 3) {
    const s = at(1);
    const g = s.guardrails[0];
    return {
      ...okVerdict(s.idx, s.title), verdict: "warn", guardrail_id: g?.id ?? null, rule: g?.rule ?? s.title,
      expert_quote: g?.quote ?? s.reason?.quote ?? "", reason: s.reason?.text ?? "Slow down and check this step.", confidence: 0.6, replay: moment(s),
    };
  }
  if (frameNo === 4) {
    const s = stopStep;
    const g = s.guardrails[0];
    return {
      ...okVerdict(s.idx, s.title), verdict: "stop", guardrail_id: g?.id ?? null, rule: g?.rule ?? s.decision.summary,
      expert_quote: g?.quote ?? s.reason?.quote ?? "", reason: `Wait. ${s.reason?.text ?? s.decision.summary}`, confidence: 0.95, replay: moment(s),
    };
  }
  // Frames 5 and 6 are "no new check" (checked: false), which must not clear the banner; frame 7 is the all-clear.
  if (frameNo <= 6) return { ...okVerdict(stopStep.idx, stopStep.title), checked: false };
  const next = at(stopPos + Math.max(0, frameNo - 7));
  return okVerdict(next.idx, next.title);
}

/** Records a verdict in the mock session (progress, time on step, stops and warnings) like the real backend does. */
export function recordVerdict(m: MockLearn, v: GuardrailVerdict, tMs: number): void {
  m.timeMs.set(m.currentIdx, (m.timeMs.get(m.currentIdx) ?? 0) + Math.max(0, tMs - m.lastT));
  m.lastT = tMs;
  if (v.step_idx) {
    m.currentIdx = v.step_idx;
    m.reached.add(v.step_idx);
  }
  const key = v.step_idx ?? m.currentIdx;
  if (v.verdict === "stop") m.stops.set(key, (m.stops.get(key) ?? 0) + 1);
  if (v.verdict === "warn") m.warns.set(key, (m.warns.get(key) ?? 0) + 1);
}

const words = (t: string) => t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);

/** Crude judge, like the backend's keyword fallback: right when half of the Master's key words are in the prediction. */
export function judgePrediction(predicted: string, expected: string): boolean {
  const want = new Set(words(expected));
  if (want.size === 0) return predicted.trim().length > 0;
  const got = new Set(words(predicted));
  let hit = 0;
  want.forEach((w) => {
    if (got.has(w)) hit++;
  });
  return hit / want.size >= 0.5;
}

/** Same formulas as the real backend: score per step, mastered at 0.75, overall = mean of all step scores x 100. */
export function buildReport(m: MockLearn, sessionId: string, summary: string): MasteryReport {
  const steps = sorted(m.skill);
  const rows: StepReport[] = steps.map((s) => {
    const reached = m.reached.has(s.idx);
    const stops = m.stops.get(s.idx) ?? 0;
    const warns = m.warns.get(s.idx) ?? 0;
    const pred = m.predictions.get(s.idx);
    const safety = Math.max(0, 1 - 0.5 * stops - 0.15 * warns);
    const score = !reached ? 0 : pred ? (safety + (pred.correct ? 1 : 0)) / 2 : safety;
    const rounded = Math.round(score * 100) / 100;
    return {
      step_idx: s.idx, title: s.title, decision_type: s.decision.type === "routine" ? "routine" : "judgment", reached,
      predicted: pred?.predicted ?? null, predicted_right: pred ? pred.correct : null, interventions: stops, warnings: warns,
      guardrail_id: s.guardrails[0]?.id ?? null, time_ms: reached ? (m.timeMs.get(s.idx) ?? 0) : null, score: rounded,
      result: !reached ? "not_reached" : rounded >= 0.75 ? "mastered" : "practise",
    };
  });
  const total = rows.reduce((n, r) => n + r.score, 0);
  const practise: PracticeItem[] = rows
    .filter((r) => r.result !== "mastered")
    .sort((a, b) => a.score - b.score)
    .map((r) => {
      const st = steps.find((s) => s.idx === r.step_idx)!;
      const bits: string[] = [];
      if (r.result === "not_reached") bits.push("You did not get to this step.");
      if (r.predicted_right === false) bits.push("Your prediction did not match the Master's decision.");
      if (r.interventions) bits.push(`Yoda had to stop you ${r.interventions} time(s).`);
      if (r.warnings) bits.push(`Yoda warned you ${r.warnings} time(s).`);
      if (st.reason) bits.push(`The Master's reason: ${st.reason.text}`);
      return { step_idx: r.step_idx, title: r.title, why: bits.join(" "), guardrail_id: st.guardrails[0]?.id ?? null, rule: st.guardrails[0]?.rule ?? null };
    });
  const preds = [...m.predictions.values()];
  return {
    session_id: sessionId, skill_id: m.skill.id, skill_title: m.skill.title,
    mastery_score: steps.length ? Math.floor((total / steps.length) * 100 + 0.5) : 0,
    steps_total: steps.length, steps_reached: rows.filter((r) => r.reached).length,
    steps_mastered: rows.filter((r) => r.result === "mastered").length,
    predictions_total: preds.length, predictions_right: preds.filter((p) => p.correct).length,
    interventions_total: rows.reduce((n, r) => n + r.interventions, 0), warnings_total: rows.reduce((n, r) => n + r.warnings, 0),
    time_total_ms: rows.reduce((n, r) => n + (r.time_ms ?? 0), 0), steps: rows, practise_next: practise, summary, summary_source: "fallback",
  };
}

export function mockSummary(r: Pick<MasteryReport, "steps_mastered" | "steps_total" | "interventions_total" | "practise_next">): string {
  const first = r.practise_next[0];
  const head = `You mastered ${r.steps_mastered} of ${r.steps_total} steps` + (r.interventions_total ? `, and I had to stop you ${r.interventions_total} time${r.interventions_total > 1 ? "s" : ""}.` : ".");
  return first ? `${head} Practise "${first.title}" again, and remember the Master's reason.` : `${head} The Holocron is yours, Padawan.`;
}
