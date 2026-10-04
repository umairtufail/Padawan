"use client";

import { useParams } from "next/navigation";
import HolocronView from "../../../../components/holocron-view";

// Full page: the fallback for direct links and refreshes, and where "Open the full Holocron" leads.
export default function HolocronPage() {
  const { id } = useParams<{ id: string }>();
  return <HolocronView id={id} />;
}
