import type { FastifyPluginAsync } from 'fastify';
import { getObjectStream } from '../services/r2.service';

// Public, unauthenticated static assets streamed from R2. Used for the LINE
// greeting image (follow event), which needs a permanent public HTTPS URL —
// LINE fetches it directly, so it can't sit behind auth or a presigned URL.
// This is NOT a user-file download (engineering rule 5), just a fixed app asset.
const GREETING_KEY = 'static/welcome.jpg';

// Onboarding images sent in order (1 → 8) on the `follow` and `join` events.
// Same public-asset pattern as welcome.jpg: LINE fetches originalContentUrl
// directly, so these must be permanent public HTTPS URLs (not presigned).
// Uploaded to R2 by scripts/upload-onboarding-images.ts.
const ONBOARDING_COUNT = 8;

const staticRoutes: FastifyPluginAsync = async (app) => {
  app.get('/static/welcome.jpg', async (_request, reply) => {
    const body = await getObjectStream(app.r2, GREETING_KEY);
    return reply
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'public, max-age=86400')
      .send(body);
  });

  // /static/onboarding/{1..8}.jpg — the numbered onboarding images. `:n` is
  // validated to the known range so this can only ever stream the fixed assets
  // (never an arbitrary R2 key).
  app.get<{ Params: { n: string } }>('/static/onboarding/:n.jpg', async (request, reply) => {
    const n = Number(request.params.n);
    if (!Number.isInteger(n) || n < 1 || n > ONBOARDING_COUNT) {
      return reply.code(404).send({ error: 'Not found' });
    }
    const body = await getObjectStream(app.r2, `static/onboarding/${n}.jpg`);
    return reply
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'public, max-age=86400')
      .send(body);
  });
};

export default staticRoutes;
