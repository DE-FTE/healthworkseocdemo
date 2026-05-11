/**
 * app/api/index-pdf/route.js
 *
 * POST /api/index-pdf
 * Body: { filename: "DEN002_2026pdf.pdf" }
 *
 * ─── What this route does ────────────────────────────────────────────────────
 *
 * This replaces the old upload route. Instead of receiving a PDF from the
 * browser, it fetches the PDF from the configured storage location:
 *
 *   PDF_SOURCE=local        → reads from /pdfs/<filename>
 *   PDF_SOURCE=r2           → downloads from Cloudflare R2 by filename
 *
 * Then runs the EXACT SAME indexing pipeline as before:
 *
 *   fetchPdfBuffer(filename)         ← lib/pdfStorage.js
 *       ↓
 *   parsePdf(buffer)                 ← pageindex library (zero LLM calls)
 *       ↓
 *   buildPageGroups(pages, ...)      ← groups pages into nodes
 *       ↓
 *   saveTreeIndex(docId, ...)        ← saves to /tmp/hw-tree-index/<docId>.json
 *       ↓
 *   SSE events streamed to browser   ← progress: stage 1/2/3 → done
 *
 * ─── Nothing changed in the pipeline ─────────────────────────────────────────
 *
 *   parsePdf()       — same call from pageindex
 *   buildPageGroups  — same function
 *   saveTreeIndex    — same storage
 *   chat/route.js    — ZERO changes, docId works identically
 */

import { parsePdf }          from 'pageindex';
import { v4 as uuidv4 }      from 'uuid';
import { fetchPdfBuffer }    from '@/lib/pdfStorage';
import { saveTreeIndex, saveTreeIndexToBlob, ensureTreeIndex } from '@/lib/treeIndex';
import { registerDoc, getRegistered } from '@/lib/indexRegistry';

// Allow up to 60 s on Vercel Pro — large PDFs can exceed the 10 s default.
export const maxDuration = 60;

const PAGES_PER_NODE = parseInt(process.env.PAGES_PER_NODE || '1', 10);

export async function POST(request) {
  const encoder = new TextEncoder();
  const emit    = (ctrl, obj) =>
    ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const safeClose = () => { if (!closed) { closed = true; controller.close(); } };

      try {
        const { filename } = await request.json();

        if (!filename?.trim()) {
          emit(controller, { event: 'error', message: 'filename is required.' });
          safeClose(); return;
        }

        // ── Check registry first — skip re-indexing if already done ─────────
        //
        // If this PDF was indexed in a previous session, its docId is in the
        // registry and the tree index JSON is in /tmp. We can reuse it directly
        // without calling parsePdf again — instant response.
        //
        // The tree index in /tmp survives as long as the server process runs.
        // On Vercel cold start, /tmp is empty but registry still has the docId —
        // in that case we fall through and re-index (parsePdf is still zero LLM calls).
        //
        const existing = await getRegistered(filename);
        if (existing?.docId) {
          // Try /tmp first, then Blob (handles Vercel cold starts where /tmp is empty)
          await ensureTreeIndex(existing.docId);
          const { loadTreeIndex } = await import('@/lib/treeIndex');
          const stored = loadTreeIndex(existing.docId);
          if (stored) {
            emit(controller, { event: 'progress', stage: 1, message: 'Loading from registry…' });
            emit(controller, {
              event:     'done',
              docId:     existing.docId,
              filename,
              nodeCount: existing.nodeCount,
              leafCount: 0,
              fromCache: true,
            });
            safeClose(); return;
          }
          // Not in /tmp or Blob — fall through and re-index
        }

        // ── Stage 1: Fetch PDF from storage ──────────────────────────────────
        emit(controller, { event: 'progress', stage: 1, message: `Loading ${filename}…` });

        const buffer = await fetchPdfBuffer(filename);

        if (!buffer || buffer.length === 0) {
          emit(controller, { event: 'error', message: 'PDF file is empty.' });
          safeClose(); return;
        }

        // ── Stage 2: Parse PDF with pageindex ─────────────────────────────────
        emit(controller, { event: 'progress', stage: 2, message: 'Parsing PDF pages…' });

        // parsePdf() from the pageindex library — local text extraction, zero LLM calls
        const pdfInfo = await parsePdf(buffer);

        if (!pdfInfo?.pages?.length) {
          emit(controller, {
            event:   'error',
            message: 'Could not extract text. Make sure the PDF has selectable text (not a scanned image).',
          });
          safeClose(); return;
        }

        // ── Stage 3: Build section index ──────────────────────────────────────
        emit(controller, { event: 'progress', stage: 3, message: 'Building section index…' });

        const structure = buildPageGroups(pdfInfo.pages, filename, PAGES_PER_NODE);

        if (!structure.length) {
          emit(controller, { event: 'error', message: 'No text content found in PDF.' });
          safeClose(); return;
        }

        const docId = uuidv4();
        const saved = saveTreeIndex(docId, filename, {
          docName:   pdfInfo.title || filename,
          structure,
        });

        // ── Persist to R2 so other Vercel instances can load it ─────────────
        // saveTreeIndexToBlob is a no-op when PDF_SOURCE !== 'r2'
        await saveTreeIndexToBlob(docId, saved);

        // ── Save to registry so this docId is reused on next startup ─────────
        await registerDoc(filename, docId, saved.nodeCount);

        emit(controller, {
          event:     'done',
          docId,
          filename,
          nodeCount: saved.nodeCount,
          leafCount: saved.leafCount,
        });

      } catch (err) {
        console.error('[index-pdf] error:', err);
        emit(controller, { event: 'error', message: err.message || 'Failed to index document.' });
      } finally {
        safeClose();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  });
}

/**
 * Group consecutive PDF pages into fixed-size TreeNode sections.
 * Identical to the function in the old upload route.
 */
function buildPageGroups(pages, docName, groupSize) {
  const nodes = [];
  for (let i = 0; i < pages.length; i += groupSize) {
    const chunk     = pages.slice(i, i + groupSize);
    const startPage = i + 1;
    const endPage   = Math.min(i + groupSize, pages.length);
    const nodeId    = String(Math.floor(i / groupSize) + 1);
    const text      = chunk.map(p => p.text).join('\n\n').trim();
    if (!text) continue;
    nodes.push({
      title:      `Pages ${startPage}–${endPage}`,
      nodeId,
      startIndex: startPage,
      endIndex:   endPage,
      text,
      nodes:      [],
    });
  }
  return nodes;
}
