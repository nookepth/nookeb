import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  listDeletedVaultFiles,
  restoreVaultFile,
  softDeleteVaultFile,
  type VaultFileRecord,
} from './vault.service';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The vault's trash lifecycle: soft delete → visible in the vault trash →
 * restorable.
 *
 * This is exercised against an in-memory table rather than a live Supabase,
 * because the property under test is the FILTER CHAIN, not the network. The
 * three functions differ only by their `.eq/.is/.not/.gte` predicates, and
 * getting one of those wrong is exactly the bug that would leak another user's
 * rows or resurrect a file the purge already claimed — so the fake applies the
 * filters for real instead of returning a canned array.
 */

type Filter = { op: string; column: string; value: unknown };

/** Minimal PostgREST-shaped fake: records the filter chain, then applies it. */
function fakeSupabase(rows: VaultFileRecord[]) {
  const state = { rows };

  function builder(mode: 'select' | 'update', patch?: Partial<VaultFileRecord>) {
    const filters: Filter[] = [];

    const matches = (row: VaultFileRecord): boolean =>
      filters.every((f) => {
        const cell = (row as unknown as Record<string, unknown>)[f.column];
        switch (f.op) {
          case 'eq':
            return cell === f.value;
          case 'is':
            return cell === f.value; // .is(col, null)
          case 'notIsNull':
            return cell !== null && cell !== undefined;
          case 'gte':
            return String(cell) >= String(f.value);
          default:
            throw new Error(`unhandled op ${f.op}`);
        }
      });

    const settle = () => {
      const hit = state.rows.filter(matches);
      if (mode === 'update') for (const row of hit) Object.assign(row, patch);
      return { data: hit.map((r) => ({ ...r })), error: null, count: hit.length };
    };

    const api = {
      eq(column: string, value: unknown) {
        filters.push({ op: 'eq', column, value });
        return api;
      },
      is(column: string, value: unknown) {
        filters.push({ op: 'is', column, value });
        return api;
      },
      not(column: string, _op: string, _value: unknown) {
        filters.push({ op: 'notIsNull', column, value: null });
        return api;
      },
      gte(column: string, value: unknown) {
        filters.push({ op: 'gte', column, value });
        return api;
      },
      order() {
        return api;
      },
      select() {
        return api;
      },
      then(resolve: (v: ReturnType<typeof settle>) => unknown) {
        return Promise.resolve(settle()).then(resolve);
      },
    };
    return api;
  }

  return {
    from() {
      return {
        select: () => builder('select'),
        update: (patch: Partial<VaultFileRecord>) => builder('update', patch),
      };
    },
  } as unknown as SupabaseClient;
}

const OWNER = 'user-1';

function vaultRow(over: Partial<VaultFileRecord> = {}): VaultFileRecord {
  return {
    id: 'file-1',
    user_id: OWNER,
    r2_key: 'vault/user-1/file-1',
    original_filename: 'passport.jpg',
    mime_type: 'image/jpeg',
    file_size: 1024,
    dek_encrypted: 'wrapped',
    iv: 'iv',
    created_at: '2026-07-01T00:00:00.000Z',
    deleted_at: null,
    ...over,
  };
}

const RETENTION_DAYS = 30;

describe('vault trash lifecycle', () => {
  it('soft-deletes a live file: stamps deleted_at instead of removing the row', async () => {
    const rows = [vaultRow()];
    const supabase = fakeSupabase(rows);

    const ok = await softDeleteVaultFile(supabase, OWNER, 'file-1');

    assert.equal(ok, true);
    // The row must SURVIVE — a hard delete would take the ciphertext's only
    // pointer with it and make restore impossible.
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]!.deleted_at, null);
  });

  it('shows the soft-deleted file in the vault trash', async () => {
    const rows = [vaultRow({ deleted_at: new Date().toISOString() })];
    const supabase = fakeSupabase(rows);

    const trash = await listDeletedVaultFiles(supabase, OWNER, RETENTION_DAYS);

    assert.equal(trash.length, 1);
    assert.equal(trash[0]!.id, 'file-1');
    assert.equal(trash[0]!.original_filename, 'passport.jpg');
  });

  it('full round trip: live file is absent from trash, then present after delete', async () => {
    const rows = [vaultRow()];
    const supabase = fakeSupabase(rows);

    assert.equal((await listDeletedVaultFiles(supabase, OWNER, RETENTION_DAYS)).length, 0);
    await softDeleteVaultFile(supabase, OWNER, 'file-1');
    assert.equal((await listDeletedVaultFiles(supabase, OWNER, RETENTION_DAYS)).length, 1);
  });

  it('restores a soft-deleted file back to live', async () => {
    const rows = [vaultRow({ deleted_at: new Date().toISOString() })];
    const supabase = fakeSupabase(rows);

    const ok = await restoreVaultFile(supabase, OWNER, 'file-1');

    assert.equal(ok, true);
    assert.equal(rows[0]!.deleted_at, null);
    assert.equal((await listDeletedVaultFiles(supabase, OWNER, RETENTION_DAYS)).length, 0);
  });

  it('hides rows already past the retention window', async () => {
    // The purge may not have run yet. Offering a restore that the next sweep
    // silently undoes is worse than not offering one at all.
    const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const supabase = fakeSupabase([vaultRow({ deleted_at: longAgo })]);

    assert.equal((await listDeletedVaultFiles(supabase, OWNER, RETENTION_DAYS)).length, 0);
  });

  it('never returns or restores another user\'s file', async () => {
    const rows = [vaultRow({ user_id: 'user-2', deleted_at: new Date().toISOString() })];
    const supabase = fakeSupabase(rows);

    assert.equal((await listDeletedVaultFiles(supabase, OWNER, RETENTION_DAYS)).length, 0);
    assert.equal(await restoreVaultFile(supabase, OWNER, 'file-1'), false);
    // and the victim's row is untouched
    assert.notEqual(rows[0]!.deleted_at, null);
  });

  it('does not re-delete an already soft-deleted file', async () => {
    // softDeleteVaultFile filters on `deleted_at IS NULL`, so a double tap is a
    // 404 rather than a silent re-stamp that would restart the retention clock.
    const first = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const rows = [vaultRow({ deleted_at: first })];
    const supabase = fakeSupabase(rows);

    assert.equal(await softDeleteVaultFile(supabase, OWNER, 'file-1'), false);
    assert.equal(rows[0]!.deleted_at, first);
  });

  it('does not restore a file that was never deleted', async () => {
    const supabase = fakeSupabase([vaultRow()]);
    assert.equal(await restoreVaultFile(supabase, OWNER, 'file-1'), false);
  });
});
