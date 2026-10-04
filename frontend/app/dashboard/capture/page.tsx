import ScreenCapture from "../../screen-capture";

export default function CapturePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-3xl font-black text-gold">Capture</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Try the screen recorder on its own. It looks at your screen a few times a second and keeps a snapshot only when something
          meaningful changes. Snapshots stay in your browser here; a teaching session also sends them to Yoda.
        </p>
      </div>
      <ScreenCapture />
    </div>
  );
}
