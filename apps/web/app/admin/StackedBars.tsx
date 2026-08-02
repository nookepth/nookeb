'use client';

/**
 * Hand-rolled stacked bar chart over a daily spine.
 *
 * Lifted out of admin/page.tsx unchanged so /admin/system can use the same
 * component instead of a near-copy that drifts. Kept as a sibling module rather
 * than exported from page.tsx: importing a component out of a route file pulls
 * that whole route's bundle into the importer. Non-special filenames inside an
 * app/ directory are not routes, which is the same pattern this repo already
 * uses for OccasionIcons.tsx and StickerArt.tsx.
 *
 * No chart library — the project has none by design (CLAUDE.md §2), and every
 * admin visual is hand-rolled SVG/CSS.
 */
export function StackedBars<T extends { day: string }>({
  data,
  series,
}: {
  data: T[];
  series: { key: keyof T; color: string }[];
}) {
  if (data.length === 0) {
    return (
      <p style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 16 }}>
        ยังไม่มีข้อมูล
      </p>
    );
  }
  const W = 720;
  const H = 180;
  const padL = 28;
  const padB = 20;
  const padT = 10;
  const total = (d: T): number => series.reduce((a, s) => a + Number(d[s.key] ?? 0), 0);
  const max = Math.max(1, ...data.map(total));
  const innerW = W - padL - 8;
  const innerH = H - padB - padT;
  const barW = innerW / data.length;
  const x = (i: number): number => padL + i * barW;
  const labelEvery = Math.ceil(data.length / 8);

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 420, display: 'block' }}>
        <line
          x1={padL}
          y1={padT}
          x2={W - 8}
          y2={padT}
          stroke="var(--color-border)"
          strokeDasharray="3 3"
        />
        <text x={padL - 4} y={padT + 3} fontSize={9} textAnchor="end" fill="var(--color-text-muted)">
          {max}
        </text>
        {data.map((d, i) => {
          let yCursor = padT + innerH;
          return (
            <g key={i}>
              {series.map((s) => {
                const v = Number(d[s.key] ?? 0);
                const h = (v / max) * innerH;
                yCursor -= h;
                return h > 0 ? (
                  <rect
                    key={String(s.key)}
                    x={x(i) + barW * 0.15}
                    y={yCursor}
                    width={barW * 0.7}
                    height={h}
                    fill={s.color}
                  />
                ) : null;
              })}
            </g>
          );
        })}
        {data.map((d, i) =>
          i % labelEvery === 0 ? (
            <text
              key={`t${i}`}
              x={x(i) + barW / 2}
              y={H - 5}
              fontSize={9}
              textAnchor="middle"
              fill="var(--color-text-muted)"
            >
              {d.day.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

export default StackedBars;
