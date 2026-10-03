"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiError, createTeachSession } from "../../../lib/api";
import { btnGhost, ErrorBox } from "../../../components/ui";

/** /dashboard/teach: creates a fresh session and jumps to it. */
export default function TeachIndex() {
  const router = useRouter();
  const [error, setError] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    createTeachSession("New task")
      .then((s) => router.replace(`/dashboard/teach/${s.session_id}`))
      .catch((err) => {
        if (!(err instanceof ApiError && err.status === 401)) setError(err instanceof Error ? err.message : "Could not create a session.");
      });
  }, [router]);

  if (error) {
    return (
      <div className="space-y-4">
        <ErrorBox>{error}</ErrorBox>
        <a href="/dashboard" className={btnGhost}>Back to overview</a>
      </div>
    );
  }
  return <p className="font-mono text-sm text-muted" role="status">Preparing a session…</p>;
}
