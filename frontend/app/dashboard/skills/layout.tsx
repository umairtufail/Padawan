import type { ReactNode } from "react";

// The @modal slot shows the Holocron popup over the Archives grid (soft navigation only).
export default function SkillsLayout({ children, modal }: { children: ReactNode; modal: ReactNode }) {
  return (
    <>
      {children}
      {modal}
    </>
  );
}
