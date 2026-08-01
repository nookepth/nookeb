import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config';
import { get as getProgress } from '../services/progress-store';

/**
 * Real-time batch upload progress. No auth: the batchId is an unguessable UUID
 * and the payload is only a counter — no file names or user data.
 */

// Self-contained page: no CDN, no external fonts, no emoji. Polls the JSON
// endpoint every 1.5s. __BATCH_ID__ / __DASHBOARD_URL__ replaced at render time.
const VIEW_HTML = `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>หนูกำลังเก็บของให้อยู่น้า</title>
<style>
  /* FIX 11 — brand red is declared ONCE here and every rule below reads it
     through var(--color-primary). This page is served by the API, not Next,
     so it cannot import apps/web/app/globals.css; the token name and value
     are kept identical to that file's :root on purpose, so "unify the brand
     red" means editing two declarations, not eleven literals. If globals.css
     --color-primary ever moves, move this line with it. */
  :root {
    --color-primary: #c0392b;
    --color-primary-soft: #f5e6e5; /* progress-bar track */
    --color-surface: #ffffff;
    --color-text-primary: #111111;
    --color-text-secondary: #8c8c8c;
  }
  body {
    margin: 0;
    font-family: -apple-system, 'Segoe UI', 'Helvetica Neue', 'Noto Sans Thai', sans-serif;
    background: var(--color-surface);
    color: var(--color-text-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
  }
  .card { text-align: center; padding: 24px; width: 100%; max-width: 360px; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 24px; }
  .counter { font-size: 48px; font-weight: 700; color: var(--color-primary); margin: 0 0 24px; }
  .bar-track {
    width: 100%;
    height: 12px;
    background: var(--color-primary-soft);
    border-radius: 6px;
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    width: 0%;
    background: var(--color-primary);
    border-radius: 6px;
    transition: width 0.4s ease;
  }
  .status { font-size: 14px; color: var(--color-text-secondary); margin-top: 24px; }
  .done .status { color: var(--color-primary); font-weight: 600; }
</style>
</head>
<body>
<div class="card" id="card">
  <h1>หนูกำลังเก็บของให้อยู่น้า</h1>
  <div class="counter" id="counter">- / -</div>
  <div class="bar-track"><div class="bar-fill" id="bar"></div></div>
  <div class="status" id="status">แป๊บนึงน้า...</div>
</div>
<script>
  var batchId = '__BATCH_ID__';
  var dashboardUrl = '__DASHBOARD_URL__';
  var timer = null;
  // The Redis progress key only appears once the worker picks up the batch, so
  // early polls can 404 for a few seconds. Tolerate that instead of failing —
  // only give up (link expired / batch genuinely gone) after N consecutive 404s.
  var notFoundCount = 0;
  var MAX_NOT_FOUND = 10; // ~40s at the 4s poll interval below

  function render(p) {
    document.getElementById('counter').textContent = p.current + ' / ' + p.total;
    var pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
    document.getElementById('bar').style.width = pct + '%';
    if (p.status === 'done') {
      clearInterval(timer);
      document.getElementById('card').className = 'card done';
      document.getElementById('status').textContent = 'เสร็จแล้วน้า พาพี่ไปดูล็อคเกอร์เลย';
      setTimeout(function () { window.location.href = dashboardUrl; }, 3000);
    }
  }

  function poll() {
    fetch('/progress/' + encodeURIComponent(batchId))
      .then(function (res) {
        if (res.status === 404) {
          // Job not started yet — keep waiting unless we've hit the limit.
          notFoundCount++;
          if (notFoundCount >= MAX_NOT_FOUND) throw new Error('not found');
          return null;
        }
        if (!res.ok) throw new Error('request failed');
        notFoundCount = 0;
        return res.json();
      })
      .then(function (p) {
        if (p) render(p);
      })
      .catch(function () {
        clearInterval(timer);
        document.getElementById('status').textContent = 'หนูหาข้อมูลไม่เจอแล้วน้า ลองเปิดใหม่อีกทีน้า';
      });
  }

  poll();
  timer = setInterval(poll, 4000);
</script>
</body>
</html>`;

const progressRoutes: FastifyPluginAsync = async (app) => {
  // GET /progress/:batchId — JSON { current, total, status }
  app.get<{ Params: { batchId: string } }>('/progress/:batchId', async (request, reply) => {
    const progress = await getProgress(request.params.batchId);
    if (!progress) return reply.code(404).send({ error: 'Batch not found' });
    return progress;
  });

  // GET /progress/:batchId/view — self-contained polling HTML page
  app.get<{ Params: { batchId: string } }>('/progress/:batchId/view', async (request, reply) => {
    const html = VIEW_HTML.replace(
      '__BATCH_ID__',
      request.params.batchId.replace(/[^a-zA-Z0-9-]/g, ''),
    ).replace('__DASHBOARD_URL__', `${config.WEB_URL}/dashboard`);
    return reply.type('text/html; charset=utf-8').send(html);
  });
};

export default progressRoutes;
