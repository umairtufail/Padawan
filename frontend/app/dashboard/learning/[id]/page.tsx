"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import MasteryReportView from "../../../../components/mastery-report";
import { ErrorBox } from "../../../../components/ui";
import { ApiError } from "../../../../lib/api";
import { getLearnReport } from "../../../../lib/learn-api";
import type { MasteryReport } from "../../../../lib/learn";

/** /dashboard/learning/[id]: id is a learn session id. Reopens the mastery report of a finished lesson. */
export default function LearningReportPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [report, setReport] = useState<MasteryReport | null>(null);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let alive = true;
    getLearnReport(id)
      .then((r) => alive && setReport(r))
      .catch((err) => {
        if (!alive || (err instanceof ApiError && err.status === 401)) return;
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else setError(err instanceof Error ? err.message : "Could not load the report.");
      });
    return () => {
      alive = false;
    };
  }, [id]);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link href="/dashboard/learning" className="font-mono text-xs text-info underline underline-offset-4">&larr; My learning</Link>
      {notFound && <ErrorBox>This lesson does not exist, or it is not yours to see.</ErrorBox>}
      {error && <ErrorBox>{error}</ErrorBox>}
      {!report && !error && !notFound && <p className="font-mono text-sm text-muted" role="status">Reading your report…</p>}
      {report && <MasteryReportView report={report} onAgain={() => router.push(`/dashboard/learn/${encodeURIComponent(report.skill_id)}`)} />}
    </div>
  );
}
