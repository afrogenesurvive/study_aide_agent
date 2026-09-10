export function LoadingModal({ message = "Loading…" }: { message?: string }) {
  return (
    <div className="loading-overlay" role="status" aria-live="polite">
      <div className="loading-card">
        <div className="spinner" />
        <p>{message}</p>
      </div>
    </div>
  );
}

export function PlaceholderPanel({
  title,
  icon,
  phase,
  description,
}: {
  title: string;
  icon: React.ReactNode;
  phase: string;
  description: string;
}) {
  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">
          {icon}
          {title}
        </h2>
        <span className="badge badge--muted">{phase}</span>
      </header>
      <div className="panel__body">
        <p className="muted">{description}</p>
      </div>
    </section>
  );
}
