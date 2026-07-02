import type { UsageResponse } from '@/lib/api';
import { formatBytes } from '@/lib/format';

const TYPE_LABEL: Record<string, string> = {
  image: 'รูปภาพ',
  pdf: 'PDF',
  video: 'วิดีโอ',
  audio: 'เสียง',
  other: 'อื่น ๆ',
};

export function UsageBar({ usage }: { usage: UsageResponse }) {
  const pct = usage.storageLimit > 0 ? Math.min(100, (usage.storageUsed / usage.storageLimit) * 100) : 0;
  const near = pct >= 90;

  return (
    <div className="usage">
      <div className="usage-head">
        <span>
          ใช้ไป <strong>{formatBytes(usage.storageUsed)}</strong> จาก {formatBytes(usage.storageLimit)} ·{' '}
          {usage.fileCount} ไฟล์
        </span>
        <span className="usage-pct">{pct.toFixed(1)}%</span>
      </div>
      <div className="usage-track">
        <div className={`usage-fill ${near ? 'near' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      {usage.byType.length > 0 && (
        <div className="usage-types">
          {usage.byType.map((t) => (
            <span key={t.type} className="usage-type">
              {TYPE_LABEL[t.type] ?? t.type}: {t.count} ({formatBytes(t.bytes)})
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
