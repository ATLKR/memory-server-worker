export function StatusPage({
  title,
  message,
  retry,
}: {
  title: string;
  message: string;
  retry?: () => void;
}) {
  return (
    <section className="status-page" aria-labelledby="status-title">
      <h1 id="status-title">{title}</h1>
      <p>{message}</p>
      <div className="status-actions">
        {retry && (
          <button type="button" className="btn btn-primary" onClick={retry}>
            Try again
          </button>
        )}
        <a href="/" className="btn btn-secondary">Go to memories</a>
      </div>
    </section>
  );
}
