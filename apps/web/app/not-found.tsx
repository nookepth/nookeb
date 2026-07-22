import Link from 'next/link';

/**
 * Rendered for unknown routes and any notFound() call in the app subtree.
 * Server component — no client interactivity needed.
 */
export default function NotFound() {
  return (
    <div className="center-page">
      <div className="error-code">404</div>
      <h1>ไม่พบหน้าที่ต้องการ</h1>
      <p className="error-desc">หน้านี้อาจถูกลบหรือ URL ไม่ถูกต้อง</p>
      <div className="error-actions">
        <Link className="btn" href="/dashboard">
          กลับหน้าหลัก
        </Link>
        <a className="btn secondary" href="mailto:support@nookeb.com">
          ติดต่อฝ่ายสนับสนุน
        </a>
      </div>
    </div>
  );
}
