import fp from 'fastify-plugin';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config';

// Service role client — server-side only, bypasses RLS.
// User-facing authorization is enforced in route handlers (space membership checks).
export default fp(async (app) => {
  const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  app.decorate('supabase', supabase);
});
