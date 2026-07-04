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
  body {
    margin: 0;
    font-family: -apple-system, 'Segoe UI', 'Helvetica Neue', 'Noto Sans Thai', sans-serif;
    background: #FFFFFF;
    color: #111111;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
  }
  .card { text-align: center; padding: 24px; width: 100%; max-width: 360px; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 24px; }
  .counter { font-size: 48px; font-weight: 700; color: #b53a32; margin: 0 0 24px; }
  .bar-track {
    width: 100%;
    height: 12px;
    background: #f5e6e5;
    border-radius: 6px;
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    width: 0%;
    background: #b53a32;
    border-radius: 6px;
    transition: width 0.4s ease;
  }
  .status { font-size: 14px; color: #8C8C8C; margin-top: 24px; }
  .done .status { color: #b53a32; font-weight: 600; }
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
        if (!res.ok) throw new Error('not found');
        return res.json();
      })
      .then(render)
      .catch(function () {
        clearInterval(timer);
        document.getElementById('status').textContent = 'หนูหาข้อมูลไม่เจอแล้วน้า ลองเปิดใหม่อีกทีน้า';
      });
  }

  poll();
  timer = setInterval(poll, 1500);
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
