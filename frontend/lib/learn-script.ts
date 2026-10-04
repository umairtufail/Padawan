/**
 * What the scripted (mock) Yoda says in NEXT_PUBLIC_API_MOCK=1. The real Yoda is the ElevenLabs tutor agent and
 * says these things on his own after the commands in lib/learn.ts. Captions only ever show what is said.
 */
import type { SkillStep } from "./skills";
import { stripWait, type GuardrailVerdict, type MasteryReport } from "./learn";

type MockSay = { text: string; tool?: { name: string; args: Record<string, unknown>; afterMs?: number } };

/** True when Yoda asks the Padawan to predict before this step (judgment steps and steps with a prompt). */
export function asksPrediction(step: SkillStep): boolean {
  return step.decision.type !== "routine" || Boolean(step.predict_prompt);
}

/**
 * Yoda teaches a step and asks what the Padawan expects. `n` counts the questions asked so far: the scripted
 * Padawan answers right the first time and wrong the second, so a demo shows both outcomes.
 */
export function mockStepSpeech(step: SkillStep, first: boolean, n: number): MockSay {
  const intro = first ? "Welcome, Padawan. A Holocron of the Master we study today. " : "";
  const ask = asksPrediction(step) ? ` ${step.predict_prompt ?? "What do you expect now?"}` : " Work through it, and I will watch.";
  const text = `${intro}Step ${step.idx}: ${step.title}.${ask}`;
  if (!asksPrediction(step)) return { text };
  const predicted = n % 2 === 0 ? step.decision.summary : "I would skip the check and move on";
  return { text, tool: { name: "record_prediction", args: { step_idx: step.idx, predicted }, afterMs: 1500 } };
}

export function mockStopSpeech(v: GuardrailVerdict): MockSay {
  const quote = v.expert_quote ? ` The Master said: "${v.expert_quote}".` : "";
  return {
    text: `Wait. The Master would stop here. ${stripWait(v.reason)} The rule: ${v.rule}.${quote} Look at his moment.`,
    tool: v.step_idx ? { name: "show_replay", args: { step_idx: v.step_idx }, afterMs: 600 } : undefined,
  };
}

export function mockWarnSpeech(v: GuardrailVerdict): MockSay {
  return { text: `Hmm. Careful. ${v.reason} What are you checking?` };
}

export function mockReportSpeech(r: Pick<MasteryReport, "mastery_score" | "summary">): MockSay {
  return { text: `Your mastery is ${r.mastery_score} of one hundred. ${r.summary}` };
}
