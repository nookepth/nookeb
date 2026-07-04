import { formatBytes } from '@/lib/format';

/** Team storage bar — green under 70%, yellow 70–90%, red 90%+. */
export function TeamStorageBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const tone = pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : '';

  return (
    <div>
      <div className="storage-track">
        <div className={`storage-fill ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="storage-label">
        <span>
          {formatBytes(used)} / {formatBytes(limit)}
        </span>
        <span>{pct.toFixed(1)}%</span>
      </div>
    </div>
  );
}
