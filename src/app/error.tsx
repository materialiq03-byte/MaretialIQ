'use client';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main>
      <h1>Something went wrong</h1>
      <div className="error-box">
        An unexpected error occurred while rendering this page.
        {error?.digest ? <span className="error-digest">Reference: {error.digest}</span> : null}
      </div>
      <button onClick={() => reset()}>Try again</button>
    </main>
  );
}
