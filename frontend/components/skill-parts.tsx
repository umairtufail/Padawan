"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, getSkill, listSkills, unpublishSkill, type SkillDetail, type SkillSummary } from "../lib/api";
import { learnersLabel, masteryLabel } from "../lib/skills";
import { btnGhost, btnPrimary, Chip } from "./ui";

export function formatDate(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function StatusChip({ status }: { status: "draft" | "published" }) {
  return status === "published" ? <Chip tone="jade">Published</Chip> : <Chip tone="gold">Draft</Chip>;
}

/** Steps, guardrails, learners and average mastery as chips. Learners and mastery are hidden while they are 0 or null. */
export function SkillStats({ skill }: { skill: Pick<SkillSummary, "steps_count" | "guardrails_count" | "learners_count" | "avg_mastery"> }) {
  const learners = learnersLabel(skill.learners_count);
  const mastery = masteryLabel(skill.avg_mastery);
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="skill-stats">
      <Chip tone="muted">{skill.steps_count} {skill.steps_count === 1 ? "step" : "steps"}</Chip>
      <Chip tone="danger">{skill.guardrails_count} {skill.guardrails_count === 1 ? "guardrail" : "guardrails"}</Chip>
      {learners && <Chip tone="info">{learners}</Chip>}
      {mastery && <Chip tone="jade">{mastery}</Chip>}
    </div>
  );
}

/** True when the signed-in user wrote this skill, null while unknown. Uses the "mine" list, since the client has no user id. */
export function useIsMine(skillId: string | undefined): boolean | null {
  const [mine, setMine] = useState<boolean | null>(null);
  useEffect(() => {
    if (!skillId) return;
    let alive = true;
    listSkills({ mine: true })
      .then((rows) => alive && setMine(rows.some((r) => r.id === skillId)))
      .catch(() => alive && setMine(false));
    return () => {
      alive = false;
    };
  }, [skillId]);
  return mine;
}

/** Two-step Unpublish for the author of a published skill. Calls onDone with the draft the API returns. */
export function UnpublishControl({ skillId, onDone }: { skillId: string; onDone: (draft: SkillDetail) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    setBusy(true);
    setError("");
    try {
      onDone(await unpublishSkill(skillId));
      setConfirming(false);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) setError(err instanceof Error ? err.message : "Could not unpublish.");
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button type="button" className={btnGhost} onClick={() => setConfirming(true)}>
        Unpublish
      </button>
    );
  }
  return (
    <div className="rounded-lg border border-gold/40 bg-gold/5 p-3 text-sm" role="group" aria-label="Confirm unpublish">
      <p className="text-fg">Take this Holocron out of the Archives? It becomes a draft only you can see.</p>
      {error && <p role="alert" className="mt-1 text-danger">{error}</p>}
      <div className="mt-2 flex gap-2">
        <button type="button" className={btnPrimary} onClick={() => void run()} disabled={busy}>
          {busy ? "Unpublishing…" : "Yes, unpublish"}
        </button>
        <button type="button" className={btnGhost} onClick={() => setConfirming(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Loads one skill by id. A 401 is handled by the api client (it sends you to /login). */
export function useSkill(id: string | undefined) {
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setError("");
    try {
      setSkill(await getSkill(id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else setError(err instanceof Error ? err.message : "Could not load this Holocron.");
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load
    void load();
  }, [load]);

  return { skill, setSkill, error, notFound, reload: load };
}
