"use client";

import { useParams } from "next/navigation";
import DebriefView from "../../../../../components/debrief-view";

/** /dashboard/teach/[id]/debrief: steps, gap questions, teach-back, then the draft Holocron. */
export default function DebriefPage() {
  const { id } = useParams<{ id: string }>();
  return <DebriefView id={id} />;
}
