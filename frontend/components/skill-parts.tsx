"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, getSkill, type SkillDetail } from "../lib/api";
import { Chip } from "./ui";

export function formatDate(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function StatusChip({ status }: { status: "draft" | "published" }) {
  return status === "published" ? <Chip tone="jade">Published</Chip> : <Chip tone="gold">Draft</Chip>;
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
