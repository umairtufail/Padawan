import { HeroCta, NavAuth } from "../components/auth-links";
import Logo from "../components/logo";
import YodaFigure from "../components/yoda-figure";
import { Label } from "../components/ui";

const features = [
  { tag: "01 / Capture", title: "Capture", body: "Yoda watches the Master's shared screen and notes every change that matters, never raw clicks alone." },
  { tag: "02 / Map", title: "Map", body: "Each session becomes a map of steps, reasons and limits: a Holocron the whole team can open." },
  { tag: "03 / Teach", title: "Teach", body: "Yoda guides the next Padawan through the task and stops them before they cross a guardrail." },
];

const steps = [
  { n: "1", title: "Share your screen", body: "Start a session and do your job as usual. Yoda watches quietly." },
  { n: "2", title: "Answer the why", body: "At natural pauses Yoda asks why you did that, by voice. Your reasons are the real skill." },
  { n: "3", title: "Train the next hire", body: "The Holocron lands in the Jedi Archives and Yoda tutors the new Padawan with it." },
];

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5">
        <Logo />
        <NavAuth />
      </header>

      <main className="flex-1">
        <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-5 py-14 md:grid-cols-[1.2fr_1fr] md:py-24">
          <div>
            <Label className="!text-jade">The AI apprentice</Label>
            <h1 className="mt-4 font-heading text-5xl font-black leading-[1.02] tracking-tight text-gold sm:text-6xl">
              Teach Yoda what you know.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
              A voice apprentice that watches an expert&apos;s screen, asks why at the right pause, and trains the next hire.
            </p>
            <div className="mt-9">
              <HeroCta />
            </div>
          </div>
          <div className="flex justify-center">
            <YodaFigure size={380} className="max-w-full" />
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-5 pb-16" aria-label="Features">
          <div className="grid gap-4 md:grid-cols-3">
            {features.map((f) => (
              <article key={f.title} className="rounded-2xl border border-line bg-surface/80 p-6">
                <Label>{f.tag}</Label>
                <h2 className="mt-3 font-heading text-2xl font-bold text-fg">{f.title}</h2>
                <p className="mt-2 leading-relaxed text-muted">{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-5 pb-24" aria-labelledby="how">
          <h2 id="how" className="font-heading text-3xl font-black text-gold">How it works</h2>
          <ol className="mt-8 grid gap-6 md:grid-cols-3">
            {steps.map((s) => (
              <li key={s.n} className="flex gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-jade/50 font-mono text-jade">
                  {s.n}
                </span>
                <div>
                  <h3 className="font-heading text-lg font-bold text-fg">{s.title}</h3>
                  <p className="mt-1 leading-relaxed text-muted">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="border-t border-line py-6 text-center">
        <Label>Hack-Nation 07 · The AI Apprentice</Label>
        <p className="mx-auto mt-3 max-w-2xl px-5 text-xs text-muted">
          Themed demo, not an official product. Star Wars and Yoda are trademarks of Lucasfilm / Disney.
        </p>
      </footer>
    </div>
  );
}
