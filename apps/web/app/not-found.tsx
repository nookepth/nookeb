import Link from 'next/link';
import { LINE_SUPPORT_URL } from '../lib/site';

/**
 * Rendered for unknown routes and any notFound() call in the app subtree.
 * Server component — no client interactivity needed.
 *
 * The support button is a real LINE OA link, not a mailto: — support@nookeb.com
 * is not a mailbox this product owns, and on desktop (no mail client registered)
 * a mailto: does nothing at all when clicked, which is exactly how it was
 * reported. Support lives in the LINE chat, same link the bot replies with.
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
        <a
          className="btn secondary"
          href={LINE_SUPPORT_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          ติดต่อฝ่ายสนับสนุน
        </a>
      </div>
    </div>
  );
}
