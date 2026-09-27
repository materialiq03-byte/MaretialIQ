export default function Loading() {
  return (
    <main className="hq-root">
      <div className="hq3-loadwrap" role="status" aria-live="polite">
        <span className="hq3-loadring" aria-hidden="true" />
        <div>
          <h1>Preparing the workspace…</h1>
          <p className="hq3-loadnote">
            MaterialIQ is composing live persisted evidence from the demonstration database. This
            usually takes a moment on the first request after the server starts.
          </p>
        </div>
      </div>
    </main>
  );
}
