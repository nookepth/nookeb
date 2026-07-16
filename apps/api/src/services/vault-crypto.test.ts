import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

// Order matters: the setup import seeds process.env before ./vault-crypto
// (and its config import) evaluates — config reads env at module load.
import './vault-crypto.test.setup';
import {
  byteRange,
  decryptStream,
  deriveUserKey,
  encryptStream,
  generateDek,
  generateFileIv,
  unwrapDek,
  wrapDek,
} from './vault-crypto';

const GCM_TAG_BYTES = 16;

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Re-chunk a buffer so stream boundaries never align with the 16-byte tag. */
function chunked(buf: Buffer, chunkSize: number): Readable {
  const pieces: Buffer[] = [];
  for (let i = 0; i < buf.length; i += chunkSize) {
    pieces.push(buf.subarray(i, i + chunkSize));
  }
  return Readable.from(pieces);
}

void test('deriveUserKey: deterministic per user, distinct across users', async () => {
  const [a1, a2, b] = await Promise.all([
    deriveUserKey('user-a'),
    deriveUserKey('user-a'),
    deriveUserKey('user-b'),
  ]);
  assert.equal(a1.length, 32);
  assert.deepEqual(a1, a2);
  assert.notDeepEqual(a1, b);
});

void test('wrapDek/unwrapDek roundtrip; wrong user key is rejected', async () => {
  const userKey = await deriveUserKey('user-a');
  const dek = generateDek();
  const wrapped = wrapDek(userKey, dek);
  assert.deepEqual(unwrapDek(userKey, wrapped), dek);

  const otherKey = await deriveUserKey('user-b');
  assert.throws(() => unwrapDek(otherKey, wrapped));
});

void test('encryptStream/decryptStream roundtrip (odd sizes, odd chunking)', async () => {
  const plain = randomBytes(1_000_003); // deliberately not a multiple of anything
  const dek = generateDek();
  const iv = generateFileIv();

  const cipherText = await collect(encryptStream(chunked(plain, 64 * 1024 + 7), dek, iv));
  assert.equal(cipherText.length, plain.length + GCM_TAG_BYTES);
  assert.notDeepEqual(cipherText.subarray(0, 32), plain.subarray(0, 32));

  // Chunk sizes below the tag size exercise the tail-holdback path hard.
  for (const chunkSize of [5, 1024, 999_999]) {
    const decrypted = await collect(decryptStream(chunked(cipherText, chunkSize), dek, iv));
    assert.deepEqual(decrypted, plain);
  }
});

void test('decryptStream: tampered ciphertext fails the GCM tag check', async () => {
  const plain = randomBytes(4096);
  const dek = generateDek();
  const iv = generateFileIv();
  const cipherText = await collect(encryptStream(Readable.from([plain]), dek, iv));

  const tampered = Buffer.from(cipherText);
  tampered[100] = tampered[100]! ^ 0xff;
  await assert.rejects(collect(decryptStream(chunked(tampered, 512), dek, iv)));
});

void test('decryptStream: truncated object (missing tag bytes) is rejected', async () => {
  const plain = randomBytes(4096);
  const dek = generateDek();
  const iv = generateFileIv();
  const cipherText = await collect(encryptStream(Readable.from([plain]), dek, iv));

  await assert.rejects(collect(decryptStream(Readable.from([cipherText.subarray(0, 8)]), dek, iv)));
  await assert.rejects(
    collect(decryptStream(chunked(cipherText.subarray(0, cipherText.length - 1), 700), dek, iv)),
  );
});

void test('byteRange: exact window regardless of chunk boundaries', async () => {
  const data = randomBytes(100_000);
  for (const [start, length] of [
    [0, 1000],
    [999, 1],
    [50_000, 50_000],
    [12_345, 6_789],
  ] as const) {
    const out = await collect(chunked(data, 3_333).pipe(byteRange(start, length)));
    assert.deepEqual(out, data.subarray(start, start + length));
  }
});
