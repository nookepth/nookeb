/**
 * Route-segment loading fallback shown while a segment suspends. Server
 * component — a centered brand spinner using the shared .spinner class.
 */
export default function Loading() {
  return (
    <div className="center-page" role="status" aria-live="polite">
      <span className="spinner" aria-hidden />
      <p className="error-desc">กำลังโหลด...</p>
    </div>
  );
}
