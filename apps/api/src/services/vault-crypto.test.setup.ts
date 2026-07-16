// Imported FIRST by vault-crypto.test.ts: config reads process.env at module
// load, so the master key (and dummies for the required vars) must exist
// before ./vault-crypto — and its config import — evaluates.
process.env['VAULT_MASTER_KEY'] = 'a'.repeat(64);
process.env['LINE_CHANNEL_ID'] ??= 'test';
process.env['LINE_CHANNEL_SECRET'] ??= 'test';
process.env['LINE_CHANNEL_ACCESS_TOKEN'] ??= 'test';
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_ROLE_KEY'] ??= 'test';
process.env['R2_ACCOUNT_ID'] ??= 'test';
process.env['R2_ACCESS_KEY_ID'] ??= 'test';
process.env['R2_SECRET_ACCESS_KEY'] ??= 'test';
process.env['JWT_SECRET'] ??= 'x'.repeat(32);
