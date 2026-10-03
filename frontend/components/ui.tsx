import Link from "next/link";
import type { ReactNode } from "react";

export const btnPrimary =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-gold px-5 py-2.5 font-heading text-sm font-bold text-[#05070d] transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-60";
export const btnGhost =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-line px-4 py-2 text-sm font-semibold text-fg transition hover:border-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info disabled:cursor-not-allowed disabled:opacity-60";

export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-xs uppercase tracking-widest text-muted ${className}`}>{children}</span>;
}

export function Chip({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "jade" | "gold" | "danger" }) {
  const tones = {
    info: "border-info/40 text-info",
    jade: "border-jade/40 text-jade",
    gold: "border-gold/40 text-gold",
    danger: "border-danger/40 text-danger",
  };
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 font-mono text-xs ${tones[tone]}`}>{children}</span>
  );
}

export function ButtonLink({ href, children, variant = "primary" }: { href: string; children: ReactNode; variant?: "primary" | "ghost" }) {
  return (
    <Link href={href} className={variant === "primary" ? btnPrimary : btnGhost}>
      {children}
    </Link>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-lg border border-danger/50 bg-danger/10 px-4 py-3 text-sm text-fg">
      <span className="font-mono text-xs uppercase tracking-widest text-danger">Error </span>
      {children}
    </div>
  );
}
