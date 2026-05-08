/**
 * lib/r2Client.js
 *
 * Shared Cloudflare R2 client (S3-compatible).
 * Lazy-initialised on first use — safe at build time even without env vars.
 *
 * Required env vars (set in Vercel dashboard):
 *   R2_ENDPOINT          https://<account_id>.r2.cloudflarestorage.com
 *   R2_ACCESS_KEY_ID     from Cloudflare R2 API token
 *   R2_SECRET_ACCESS_KEY from Cloudflare R2 API token
 *   R2_BUCKET_NAME       eoc-data
 */

import { S3Client } from '@aws-sdk/client-s3';

let _client = null;

export function getR2Client() {
  if (!_client) {
    _client = new S3Client({
      region:   'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return _client;
}

export function getR2Bucket() {
  return process.env.R2_BUCKET_NAME || 'eoc-data';
}

/**
 * Read a Node.js Readable stream (R2 response body) into a Buffer.
 */
export async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
