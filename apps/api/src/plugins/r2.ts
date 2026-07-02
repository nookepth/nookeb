import fp from 'fastify-plugin';
import { createR2Client } from '../services/r2.service';

export default fp(async (app) => {
  app.decorate('r2', createR2Client());
});
