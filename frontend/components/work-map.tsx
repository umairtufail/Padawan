import { buildWorkMap, formatTimestamp, guardrailLabel, type SkillJson } from "../lib/skills";

type Props = {
  skill: Pick<SkillJson, "steps" | "global_guardrails">;
  selected: number | null;
  onSelect: (idx: number) => void;
};

/**
 * The visual work map: the Master's path as a spine of step nodes. Judgment calls glow gold, routine
 * steps are plain, and every guardrail hangs off its step as a red branch. Vertical so it reads the
 * same on a phone. Each node is a real button (keyboard and screen reader friendly).
 */
export default function WorkMap({ skill, selected, onSelect }: Props) {
  const nodes = buildWorkMap(skill);
  return (
    <ol aria-label="Work map" className="relative space-y-4">
      <span aria-hidden className="absolute bottom-6 left-[19px] top-6 w-px bg-gradient-to-b from-jade/70 via-jade/30 to-gold/40" />
      {nodes.map((n) => {
        const active = n.idx === selected;
        return (
          <li key={n.idx} className="relative pl-12">
            <span
              aria-hidden
              className={`absolute left-0 top-1 flex h-10 w-10 items-center justify-center rounded-full border-2 bg-bg font-heading text-sm font-black ${
                n.emphasis ? "border-gold text-gold shadow-[0_0_18px_rgba(255,210,74,0.35)]" : "border-jade/60 text-jade"
              } ${active ? "ring-2 ring-info ring-offset-2 ring-offset-bg" : ""}`}
            >
              {n.idx}
            </span>
            <button
              type="button"
              onClick={() => onSelect(n.idx)}
              aria-current={active ? "step" : undefined}
              className={`block w-full rounded-xl border p-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info ${
                active ? "border-gold/70 bg-surface-2" : "border-line bg-surface/80 hover:border-jade/60"
              }`}
            >
              <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-heading text-base font-bold text-fg">{n.title}</span>
                <span className="font-mono text-xs text-muted">{formatTimestamp(n.t_ms)}</span>
              </span>
              <span className="mt-1 block font-mono text-[11px] uppercase tracking-widest text-muted">{n.decisionType}</span>
            </button>
            {n.guardrails.length > 0 && (
              <ul aria-label={`Guardrails of step ${n.idx}`} className="mt-2 space-y-1.5 border-l border-dashed border-danger/50 pl-3">
                {n.guardrails.map((g) => (
                  <li key={g.id} className="flex items-start gap-2 text-xs text-fg">
                    <span aria-hidden className="mt-1 inline-block h-2 w-2 shrink-0 rotate-45 bg-danger" />
                    <span>
                      <span className="font-mono uppercase tracking-wider text-danger">{guardrailLabel(g.type)}</span>{" "}
                      <span className="text-muted">{g.rule}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
      {skill.global_guardrails.length > 0 && (
        <li className="relative pl-12">
          <span aria-hidden className="absolute left-0 top-1 flex h-10 w-10 items-center justify-center rounded-full border-2 border-danger bg-bg text-danger">
            <span className="h-3 w-3 rotate-45 bg-danger" />
          </span>
          <div className="rounded-xl border border-danger/40 bg-danger/5 p-3">
            <p className="font-heading text-base font-bold text-fg">Always, in every step</p>
            <ul className="mt-1 space-y-1">
              {skill.global_guardrails.map((g) => (
                <li key={g.id} className="text-xs text-muted">
                  <span className="font-mono uppercase tracking-wider text-danger">{guardrailLabel(g.type)}</span> {g.rule}
                </li>
              ))}
            </ul>
          </div>
        </li>
      )}
    </ol>
  );
}
