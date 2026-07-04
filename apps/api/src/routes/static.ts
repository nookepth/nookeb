import type { FastifyPluginAsync } from 'fastify';
import { getObjectStream } from '../services/r2.service';

// Public, unauthenticated static assets streamed from R2. Used for the LINE
// greeting image (follow event), which needs a permanent public HTTPS URL —
// LINE fetches it directly, so it can't sit behind auth or a presigned URL.
// This is NOT a user-file download (engineering rule 5), just a fixed app asset.
const GREETING_KEY = 'static/welcome.jpg';

const staticRoutes: FastifyPluginAsync = async (app) => {
  app.get('/static/welcome.jpg', async (_request, reply) => {
    const body = await getObjectStream(app.r2, GREETING_KEY);
    return reply
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'public, max-age=86400')
      .send(body);
  });
};

export default staticRoutes;
