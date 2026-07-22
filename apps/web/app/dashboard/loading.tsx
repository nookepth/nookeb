/**
 * Loading fallback for the dashboard subtree while a segment suspends.
 * Centered brand spinner (shared .spinner class).
 */
export default function DashboardLoading() {
  return (
    <div className="center-page" role="status" aria-live="polite">
      <span className="spinner" aria-hidden />
      <p className="error-desc">กำลังโหลด...</p>
    </div>
  );
}
