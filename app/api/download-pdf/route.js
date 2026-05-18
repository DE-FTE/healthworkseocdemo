/**
 * app/api/download-pdf/route.js
 *
 * GET /api/download-pdf?filename=H0976-001-000.pdf
 *
 * Streams the requested PDF from whichever storage backend is configured
 * (PDF_SOURCE=local → /pdfs folder, PDF_SOURCE=r2 → Cloudflare R2).
 * Reuses fetchPdfBuffer() from lib/pdfStorage so no new storage logic needed.
 */

import { fetchPdfBuffer } from '@/lib/pdfStorage';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const filename = searchParams.get('filename');

  if (!filename?.trim()) {
    return Response.json({ error: 'filename is required.' }, { status: 400 });
  }

  // Strip any path separators — only plain filenames are allowed.
  const safe = filename.replace(/[/\\]/g, '').trim();
  if (!safe.toLowerCase().endsWith('.pdf')) {
    return Response.json({ error: 'Only PDF files may be downloaded.' }, { status: 400 });
  }

  try {
    const buffer = await fetchPdfBuffer(safe);
    return new Response(buffer, {
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${safe}"`,
        'Content-Length':      buffer.length.toString(),
        'Cache-Control':       'no-store',
      },
    });
  } catch (err) {
    console.error('[download-pdf]', err);
    return Response.json({ error: err.message || 'File not found.' }, { status: 404 });
  }
}
