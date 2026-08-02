import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { S3Client } from '@aws-sdk/client-s3';
import { runR2Reconciliation } from './r2Reconcile.job';

/**
 * R2 ↔ Postgres drift audit (Feature 30).
 *
 * Two properties are worth pinning, and they pull in opposite directions:
 *
 *   1. MISSING objects MUST be marked. A files row whose object is gone is a
 *      download button that 404s; flipping status to 'error' is what makes the
 *      product honest about it.
 *   2. ORPHANS MUST NEVER BE DELETED, and must not even be REPORTED from a
 *      degraded run. The orphan set is computed by SUBTRACTION, so a key source
 *      that returns too few rows does not produce a small error — it produces a
 *      confident list of live user files. The tests below prove a failed source
 *      suppresses the list entirely.
 *
 * The S3 client is stubbed at `send`, which is the only method this path uses.
 */

/** An S3Client that returns `keys` as one un-truncated ListObjectsV2 page. */
function fakeR2(keys: string[]): S3Client {
  return {
    send: async () => ({ Contents: keys.map((Key) => ({ Key })), IsTruncated: false }),
  } as unknown as S3Client;
}

interface DbUpdate {
  table: string;
  values: Record<string, unknown>;
  inKeys: string[];
}

/**
 * A Supabase stand-in that serves one page per table and records UPDATEs.
 *
 * `tables` maps a table name to its rows. A name listed in `failing` throws on
 * select, which is how a degraded run is simulated. Filters (`is`, `not`,
 * `order`) are accepted and ignored — the tests seed exactly the rows each case
 * needs, so "every row" is the right answer to every query.
 */
function fakeDb(
  tables: Record<string, Record<string, unknown>[]>,
  updates: DbUpdate[],
  failing: string[] = [],
): SupabaseClient {
  const from = (table: string): Record<string, unknown> => {
    const state: { values: Record<string, unknown>; inKeys: string[] } = { values: {}, inKeys: [] };
    const builder: Record<string, unknown> = {};
    const chain = (): Record<string, unknown> => builder;

    builder.select = () => {
      // A select is awaited directly (no .single()), so the builder is a thenable.
      const rows = tables[table] ?? [];
      const q: Record<string, unknown> = {};
      ['is', 'not', 'order', 'eq'].forEach((name) => {
        q[name] = () => q;
      });
      q.range = (from_: number, to: number) => {
        const page = { ...q } as Record<string, unknown>;
        page.then = (resolve: (v: unknown) => void) =>
          resolve(
            failing.includes(table)
              ? { data: null, error: { message: `relation "${table}" does not exist` } }
              : { data: rows.slice(from_, to + 1), error: null },
          );
        return page;
      };
      return q;
    };

    builder.update = (values: Record<string, unknown>) => {
      state.values = values;
      const u: Record<string, unknown> = {};
      u.in = (_col: string, keys: string[]) => {
        state.inKeys = keys;
        updates.push({ table, values: state.values, inKeys: keys });
        return Promise.resolve({ data: null, error: null });
      };
      return u;
    };

    void chain;
    return builder;
  };
  return { from } as unknown as SupabaseClient;
}

/** Every key-bearing table, empty unless a case fills it. */
function emptyTables(): Record<string, Record<string, unknown>[]> {
  return {
    files: [],
    scan_pages: [],
    diary_entries: [],
    vault_files: [],
    legacy_box_photos: [],
    legacy_boxes: [],
  };
}

describe('runR2Reconciliation — missing objects', () => {
  it("marks a live files row whose object is gone as status='error'", async () => {
    const tables = emptyTables();
    tables.files = [
      { r2_key: 'spaces/s1/files/f1/a.pdf', thumbnail_key: null, status: 'ready' },
      { r2_key: 'spaces/s1/files/f2/b.pdf', thumbnail_key: null, status: 'ready' },
    ];
    const updates: DbUpdate[] = [];
    // Only f1's object exists in the bucket.
    const r2 = fakeR2(['spaces/s1/files/f1/a.pdf']);

    const res = await runR2Reconciliation(fakeDb(tables, updates), r2);

    assert.deepEqual(res.missing, ['spaces/s1/files/f2/b.pdf']);
    assert.equal(updates.length, 1);
    assert.equal(updates[0]!.table, 'files');
    assert.equal(updates[0]!.values.status, 'error');
    assert.deepEqual(updates[0]!.inKeys, ['spaces/s1/files/f2/b.pdf']);
  });

  it('writes nothing and reports nothing when the two stores agree', async () => {
    const tables = emptyTables();
    tables.files = [{ r2_key: 'spaces/s1/files/f1/a.pdf', thumbnail_key: null, status: 'ready' }];
    const updates: DbUpdate[] = [];

    const res = await runR2Reconciliation(
      fakeDb(tables, updates),
      fakeR2(['spaces/s1/files/f1/a.pdf']),
    );

    assert.deepEqual(res.missing, []);
    assert.deepEqual(res.orphans, []);
    assert.equal(updates.length, 0);
  });
});

describe('runR2Reconciliation — orphans', () => {
  it('reports an unclaimed object, and does not delete it', async () => {
    const tables = emptyTables();
    tables.files = [{ r2_key: 'spaces/s1/files/f1/a.pdf', thumbnail_key: null, status: 'ready' }];
    const updates: DbUpdate[] = [];

    const res = await runR2Reconciliation(
      fakeDb(tables, updates),
      fakeR2(['spaces/s1/files/f1/a.pdf', 'spaces/s1/files/ghost/x.pdf']),
    );

    assert.deepEqual(res.orphans, ['spaces/s1/files/ghost/x.pdf']);
    // The S3 stub has no delete; the assertion that matters is that the ONLY
    // write anywhere was the status flip — and there was none here.
    assert.equal(updates.length, 0);
  });

  it('does NOT flag thumbnails, diary photos, vault blobs or gift-box audio', async () => {
    // The false-positive case this whole KEY_SOURCES table exists to prevent.
    // None of these keys appears in files.r2_key, and subtracting only that one
    // column would report every one of them as an orphan.
    const tables = emptyTables();
    tables.files = [
      { r2_key: 'spaces/s1/files/f1/a.pdf', thumbnail_key: 'spaces/s1/thumbnails/f1/thumb.webp', status: 'ready' },
    ];
    tables.scan_pages = [{ r2_key: 'spaces/s1/scan-temp/sess/p1.jpg' }];
    tables.diary_entries = [{ image_key: 'diary/u1/2026-08-02.jpg', thumbnail_key: 'diary/u1/thumb.webp' }];
    tables.vault_files = [{ r2_key: 'vault/u1/abc.enc' }];
    tables.legacy_box_photos = [{ r2_key: 'legacy-box/b1/p1.jpg' }];
    tables.legacy_boxes = [{ audio_key: 'legacy-box/b1/voice.m4a' }];

    const res = await runR2Reconciliation(
      fakeDb(tables, []),
      fakeR2([
        'spaces/s1/files/f1/a.pdf',
        'spaces/s1/thumbnails/f1/thumb.webp',
        'spaces/s1/scan-temp/sess/p1.jpg',
        'diary/u1/2026-08-02.jpg',
        'diary/u1/thumb.webp',
        'vault/u1/abc.enc',
        'legacy-box/b1/p1.jpg',
        'legacy-box/b1/voice.m4a',
      ]),
    );

    assert.deepEqual(res.orphans, []);
    assert.deepEqual(res.missing, []);
  });

  it('SUPPRESSES the orphan list when a key source could not be read', async () => {
    // The safety property. vault_files is unreadable, so every vault object
    // looks unclaimed — reporting them would hand an admin a list of live,
    // encrypted user files described as orphans.
    const tables = emptyTables();
    tables.files = [{ r2_key: 'spaces/s1/files/f1/a.pdf', thumbnail_key: null, status: 'ready' }];
    tables.vault_files = [{ r2_key: 'vault/u1/abc.enc' }];

    const res = await runR2Reconciliation(
      fakeDb(tables, [], ['vault_files']),
      fakeR2(['spaces/s1/files/f1/a.pdf', 'vault/u1/abc.enc']),
    );

    assert.deepEqual(res.orphans, []);
    assert.match(res.summary, /DEGRADED/);
  });

  it('still marks missing objects on a degraded run — the two halves are independent', async () => {
    // A failed vault read says nothing about whether a files row's object
    // exists, so the correction that IS safe still happens.
    const tables = emptyTables();
    tables.files = [{ r2_key: 'spaces/s1/files/f1/a.pdf', thumbnail_key: null, status: 'ready' }];
    const updates: DbUpdate[] = [];

    const res = await runR2Reconciliation(fakeDb(tables, updates, ['vault_files']), fakeR2([]));

    assert.deepEqual(res.missing, ['spaces/s1/files/f1/a.pdf']);
    assert.equal(updates.length, 1);
    assert.equal(updates[0]!.values.status, 'error');
  });
});
