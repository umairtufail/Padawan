export type PresenceState = "off" | "idle" | "listening" | "speaking" | "waiting";

const LABEL: Record<PresenceState, string> = {
  off: "Yoda is not connected",
  idle: "Yoda is quiet and watching",
  listening: "Yoda is listening to the Master",
  speaking: "Yoda is speaking",
  waiting: "Yoda is waiting for the answer",
};

/** Animated Yoda: our own CSS (orb, rings, eyes), no film art. The state drives the animation (see globals.css). */
export default function YodaPresence({ state, size = 120 }: { state: PresenceState; size?: number }) {
  return (
    <div
      className="yoda-presence"
      data-state={state}
      role="img"
      aria-label={LABEL[state]}
      style={{ "--size": `${size}px` } as React.CSSProperties}
    >
      <span className="ring" />
      <span className="ring" />
      <span className="core" />
      <span className="eyes" aria-hidden>
        <i />
        <i />
      </span>
    </div>
  );
}
