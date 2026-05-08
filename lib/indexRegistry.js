/**
 * lib/indexRegistry.js
 *
 * Persistent registry mapping PDF filenames → docIds.
 *
 * ─── Storage strategy ────────────────────────────────────────────────────────
 *
 *   Local dev (PDF_SOURCE=local):
 *     ./pdfs/.registry.json — persists across server restarts
 *
 *   Cloudflare R2 (PDF_SOURCE=r2):
 *     One R2 object per document: hw-pdf-registry/{filename}.json
 *
 *     WHY per-document objects (not a single JSON):
 *       Concurrent index-pdf calls write to DIFFERENT keys — no overwrite race.
 *       getRegistered() does a direct GET by key — no listing needed, very fast.
 *
 * ─── Schema ───────────────────────────────────────────────────────────────────
 *
 *   hw-pdf-registry/H0976-001-000.pdf.json →
 *   {
 *     "docId":     "f3a2b1c4-9e8d-4f1a-b2c3-d4e5f6a7b8c9",
 *     "indexedAt": "2026-05-08T17:00:00.000Z",
 *     "nodeCount": 343
 *   }
 */

import fs   from 'fs';
import path from 'path';

const ON_R2       = process.env.PDF_SOURCE === 'r2';
const R2_PREFIX   = 'hw-pdf-registry/';
const LOCAL_PATH  = path.join(process.cwd(), 'pdfs', '.registry.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function r2Get(key) {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getR2Client, getR2Bucket, streamToBuffer } = await import('./r2Client.js');
  const resp = await getR2Client().send(
    new GetObjectCommand({ Bucket: getR2Bucket(), Key: key })
  );
  const buf = await streamToBuffer(resp.Body);
  return JSON.parse(buf.toString('utf8'));
}

async function r2Put(key, data) {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { getR2Client, getR2Bucket } = await import('./r2Client.js');
  await getR2Client().send(new PutObjectCommand({
    Bucket:      getR2Bucket(),
    Key:         key,
    Body:        JSON.stringify(data),
    ContentType: 'application/json',
  }));
}

async function r2Delete(key) {
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const { getR2Client, getR2Bucket } = await import('./r2Client.js');
  await getR2Client().send(
    new DeleteObjectCommand({ Bucket: getR2Bucket(), Key: key })
  );
}

// ─── Read entire registry (used by /api/documents to enrich file list) ────────

export async function readRegistry() {
  if (ON_R2) {
    try {
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const { getR2Client, getR2Bucket, streamToBuffer } = await import('./r2Client.js');
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const client = getR2Client();
      const bucket = getR2Bucket();

      const listResp = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: R2_PREFIX })
      );
      const objects = (listResp.Contents || []).filter(o => o.Key.endsWith('.json'));
      if (objects.length === 0) return {};

      const entries = await Promise.all(
        objects.map(async obj => {
          try {
            const resp = await client.send(
              new GetObjectCommand({ Bucket: bucket, Key: obj.Key })
            );
            const text     = (await streamToBuffer(resp.Body)).toString('utf8');
            const entry    = JSON.parse(text);
            const filename = obj.Key.slice(R2_PREFIX.length).replace(/\.json$/, '');
            return [filename, entry];
          } catch { return null; }
        })
      );
      return Object.fromEntries(entries.filter(Boolean));
    } catch (err) {
      console.warn('[registry] R2 readRegistry failed:', err.message);
      return {};
    }
  }

  try {
    if (!fs.existsSync(LOCAL_PATH)) return {};
    return JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8'));
  } catch { return {}; }
}

// ─── Register a newly-indexed document ────────────────────────────────────────

export async function registerDoc(filename, docId, nodeCount) {
  const entry = { docId, indexedAt: new Date().toISOString(), nodeCount };
  if (ON_R2) {
    try {
      await r2Put(`${R2_PREFIX}${filename}.json`, entry);
    } catch (err) {
      console.warn('[registry] R2 registerDoc failed:', err.message);
    }
    return;
  }
  const reg = await readRegistry();
  reg[filename] = entry;
  const dir = path.dirname(LOCAL_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(reg, null, 2), 'utf8');
}

// ─── Look up a single file (direct GET — no listing needed) ───────────────────

export async function getRegistered(filename) {
  if (ON_R2) {
    try {
      return await r2Get(`${R2_PREFIX}${filename}.json`);
    } catch (err) {
      // NoSuchKey → not indexed yet
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      console.warn('[registry] R2 getRegistered failed:', err.message);
      return null;
    }
  }
  try {
    if (!fs.existsSync(LOCAL_PATH)) return null;
    const reg = JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8'));
    return reg[filename] || null;
  } catch { return null; }
}

// ─── Remove a document from the registry ──────────────────────────────────────

export async function unregisterDoc(filename) {
  if (ON_R2) {
    try {
      await r2Delete(`${R2_PREFIX}${filename}.json`);
    } catch (err) {
      console.warn('[registry] R2 unregisterDoc failed:', err.message);
    }
    return;
  }
  try {
    if (!fs.existsSync(LOCAL_PATH)) return;
    const reg = JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8'));
    delete reg[filename];
    fs.writeFileSync(LOCAL_PATH, JSON.stringify(reg, null, 2), 'utf8');
  } catch { /* ignore */ }
}
