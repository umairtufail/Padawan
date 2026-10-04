/** Pure helpers for "My learning" (GET /v1/learn/sessions). No network or browser code. */

/** One row of GET /v1/learn/sessions. */
export type LearnSessionRow = {
  session_id: string;
  /** null when the skill was deleted since. */
  skill_id: string | null;
  skill_title: string;
  created_at: string;
  finished: boolean;
  /** null until the lesson is finished. */
  mastery_score: number | null;
  steps_total: number;
  steps_done: number;
};

/** Newest first. Returns a new array. */
export function sortSessions(rows: LearnSessionRow[]): LearnSessionRow[] {
  return [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** 0 to 100, safe for zero steps and for steps_done above steps_total. */
export function progressPercent(row: Pick<LearnSessionRow, "steps_done" | "steps_total">): number {
  if (!row.steps_total || row.steps_total < 1) return 0;
  return Math.round(Math.min(1, Math.max(0, row.steps_done / row.steps_total)) * 100);
}

export function progressLabel(row: Pick<LearnSessionRow, "steps_done" | "steps_total">): string {
  const total = Math.max(0, row.steps_total);
  return `${Math.min(Math.max(0, row.steps_done), total)} of ${total} steps`;
}

/** The lesson to offer as "Continue learning": the newest unfinished one whose skill still exists. */
export function pickContinue(rows: LearnSessionRow[]): (LearnSessionRow & { skill_id: string }) | null {
  const found = sortSessions(rows).find((r) => !r.finished && r.skill_id !== null);
  return found ? ({ ...found } as LearnSessionRow & { skill_id: string }) : null;
}

export type LearningStats = { total: number; finished: number; inProgress: number; avgMastery: number | null };

export function learningStats(rows: LearnSessionRow[]): LearningStats {
  const scores = rows.filter((r) => r.finished && r.mastery_score !== null).map((r) => r.mastery_score as number);
  return {
    total: rows.length,
    finished: rows.filter((r) => r.finished).length,
    inProgress: rows.filter((r) => !r.finished).length,
    avgMastery: scores.length ? Math.round(scores.reduce((n, v) => n + v, 0) / scores.length) : null,
    // (scores may be floats from the API; only the average is shown, rounded)
  };
}
