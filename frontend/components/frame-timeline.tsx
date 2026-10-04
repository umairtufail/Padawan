import { Chip, Label } from "./ui";
import type { FrameStatus, TimelineItem } from "../lib/use-frame-buffer";

const STATUS: Record<FrameStatus, { label: string; tone: "info" | "jade" | "gold" | "danger" | "muted"; live?: boolean }> = {
  queued: { label: "waiting in the buffer", tone: "muted" },
  sending: { label: "Yoda is looking", tone: "gold", live: true },
  analyzed: { label: "analysed", tone: "jade" },
  skipped: { label: "skipped", tone: "info" },
  failed: { label: "failed", tone: "danger" },
  dropped: { label: "dropped", tone: "muted" },
};

function clock(d: Date) {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function relative(ms: number) {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `+${m}:${s}`;
}

function kb(bytes: number) {
  return bytes < 1_000_000 ? `${Math.round(bytes / 1_000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function Row({ item }: { item: TimelineItem }) {
  const st = STATUS[item.status];
  const salient = item.events.some((e) => e.salient);
  return (
    <li className="relative grid grid-cols-[84px_1fr] gap-4 pb-6 last:pb-0" data-status={item.status}>
      {/* time column + the dot on the vertical line */}
      <div className="relative text-right">
        <p className="font-mono text-sm font-semibold tabular-nums text-fg">{clock(item.takenAt)}</p>
        <p className="font-mono text-xs tabular-nums text-muted">{relative(item.tMs)}</p>
        <span
          aria-hidden="true"
          className={`absolute -right-[14px] top-1.5 h-3 w-3 rounded-full border-2 border-bg ${
            item.status === "analyzed" ? "bg-jade" : item.status === "sending" ? "animate-pulse bg-gold" : item.status === "failed" ? "bg-danger" : "bg-muted"
          }`}
        />
      </div>

      <article className={`rounded-xl border p-4 ${salient ? "border-gold/50 bg-gold/5" : "border-line bg-surface/80"}`}>
        <div className="flex flex-col gap-4 sm:flex-row">
          <a
            href={item.thumbUrl}
            target="_blank"
            rel="noreferrer"
            className="relative block w-full shrink-0 overflow-hidden rounded-lg border border-line bg-black sm:w-52"
            aria-label={`Open the image taken at ${clock(item.takenAt)}`}
          >
            {/* The image only exists as a local browser blob during this session. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.thumbUrl} alt="" className="aspect-video w-full object-cover" />
            {item.region && (
              <span
                aria-hidden="true"
                className="absolute rounded-sm border-2 border-gold bg-gold/15"
                style={{ left: `${item.region.x * 100}%`, top: `${item.region.y * 100}%`, width: `${item.region.w * 100}%`, height: `${item.region.h * 100}%` }}
              />
            )}
          </a>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={st.tone}>
                {st.live && <span aria-hidden="true" className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-gold" />}
                {st.label}
              </Chip>
              <Chip tone={item.reason === "initial" ? "info" : "muted"}>
                {item.reason === "initial" ? "first look" : `changed ${item.changedPercent.toFixed(1)}%`}
              </Chip>
              {item.latencyMs !== null && <span className="font-mono text-xs text-muted">{item.latencyMs} ms</span>}
              <span className="font-mono text-xs text-muted">{item.width}×{item.height} · {kb(item.bytes)}</span>
            </div>

            {item.status === "analyzed" && (
              <div className="mt-3 space-y-2">
                {item.events.length === 0 ? (
                  <p className="text-sm text-muted">Nothing new to report, the screen is the same in substance.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {item.events.map((ev) => (
                      <li key={ev.id} className="text-fg">
                        <span className={`mr-2 font-mono text-xs uppercase ${ev.salient ? "text-gold" : "text-info"}`}>{ev.kind}</span>
                        {ev.summary}
                      </li>
                    ))}
                  </ul>
                )}
                {item.summary && (
                  <p className="border-l-2 border-jade/50 pl-3 text-sm text-muted">
                    <span className="font-mono text-xs uppercase tracking-widest text-jade">Yoda sees </span>
                    {item.summary}
                  </p>
                )}
              </div>
            )}
            {(item.status === "queued" || item.status === "sending") && (
              <p className="mt-3 text-sm text-muted">
                {item.status === "queued" ? "Waiting for its turn, frames are sent in order, one at a time." : "Being analysed by the vision model…"}
              </p>
            )}
            {item.note && <p className="mt-3 text-sm text-muted">{item.note}</p>}
          </div>
        </div>
      </article>
    </li>
  );
}

/** Every captured image in order, with the time it was taken and what the model made of it. Newest first. */
export default function FrameTimeline({ items }: { items: TimelineItem[] }) {
  const newestFirst = [...items].reverse();
  return (
    <section aria-labelledby="timeline-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="timeline-title" className="font-heading text-2xl font-black text-gold">Frame timeline</h2>
        <Label>{items.length} {items.length === 1 ? "frame" : "frames"}</Label>
      </div>
      <p className="mt-1 text-sm text-muted">
        Each image waits in a buffer, is sent in order, and keeps the moment it was taken and what Yoda made of it.
      </p>

      {items.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-line p-6 text-muted">
          Frames show up here as the screen changes. The first one is taken the moment recording starts.
        </p>
      ) : (
        <ol className="relative mt-6 before:absolute before:bottom-2 before:left-[91px] before:top-2 before:w-0.5 before:bg-line">
          {newestFirst.map((item) => <Row key={item.id} item={item} />)}
        </ol>
      )}
    </section>
  );
}
