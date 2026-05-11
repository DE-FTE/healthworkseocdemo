/**
 * lib/pdfStorage.js
 *
 * Storage abstraction for pre-stored PDFs.
 * Supports two backends, configured via PDF_SOURCE in .env.local:
 *
 * ─── LOCAL (default, development) ────────────────────────────────────────────
 *
 *   PDF_SOURCE=local
 *   Drop PDF files into the /pdfs folder in the project root.
 *
 * ─── CLOUDFLARE R2 (production) ──────────────────────────────────────────────
 *
 *   PDF_SOURCE=r2
 *   R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
 *   R2_ACCESS_KEY_ID=...
 *   R2_SECRET_ACCESS_KEY=...
 *   R2_BUCKET_NAME=eoc-data
 *   R2_PDF_FOLDER=eocdata          (folder inside the bucket, default: eocdata)
 */

import fs   from 'fs';
import path from 'path';

const SOURCE    = process.env.PDF_SOURCE    || 'local';
const LOCAL_DIR = process.env.PDF_LOCAL_DIR
  ? path.resolve(process.env.PDF_LOCAL_DIR)
  : path.join(process.cwd(), 'pdfs');

// R2 folder where PDFs are stored, e.g. "eocdata" → keys are "eocdata/<filename>"
const R2_PDF_FOLDER = (() => {
  const f = process.env.R2_PDF_FOLDER || 'eocdata';
  return f.endsWith('/') ? f : f + '/';
})();

// ─── List all PDFs ────────────────────────────────────────────────────────────

export async function listPdfs() {
  if (SOURCE === 'r2') return listFromR2();
  return listFromLocal();
}

async function listFromLocal() {
  if (!fs.existsSync(LOCAL_DIR)) {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    return [];
  }
  return fs.readdirSync(LOCAL_DIR)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .map(f => {
      const stats = fs.statSync(path.join(LOCAL_DIR, f));
      return { name: f, size: stats.size, lastModified: stats.mtime.toISOString() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function listFromR2() {
  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const { getR2Client, getR2Bucket } = await import('./r2Client.js');
  const client = getR2Client();
  const bucket = getR2Bucket();

  const allObjects = [];
  let continuationToken;
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket:            bucket,
      Prefix:            R2_PDF_FOLDER,
      ContinuationToken: continuationToken,
    }));
    allObjects.push(...(response.Contents || []));
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return allObjects
    .filter(obj => obj.Key.toLowerCase().endsWith('.pdf'))
    .map(obj => ({
      name:         obj.Key.slice(R2_PDF_FOLDER.length),
      size:         obj.Size,
      lastModified: obj.LastModified?.toISOString() || '',
    }))
    .filter(obj => obj.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Fetch a specific PDF as a Buffer ────────────────────────────────────────

export async function fetchPdfBuffer(filename) {
  if (SOURCE === 'r2') return fetchFromR2(filename);
  return fetchFromLocal(filename);
}

async function fetchFromLocal(filename) {
  const safe = path.basename(filename);
  const full  = path.join(LOCAL_DIR, safe);
  if (!fs.existsSync(full)) throw new Error(`PDF not found in local storage: ${safe}`);
  return fs.readFileSync(full);
}

async function fetchFromR2(filename) {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getR2Client, getR2Bucket, streamToBuffer } = await import('./r2Client.js');
  const client = getR2Client();
  const bucket = getR2Bucket();
  const key    = `${R2_PDF_FOLDER}${path.basename(filename)}`;

  const command  = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await client.send(command);
  return streamToBuffer(response.Body);
}

// ─── Storage info (for display) ───────────────────────────────────────────────

export function getStorageInfo() {
  if (SOURCE === 'r2') return { type: 'Cloudflare R2', label: 'Cloud Storage (R2)' };
  return { type: 'local', label: 'Local · /pdfs/' };
}
