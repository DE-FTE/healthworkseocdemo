/**
 * app/api/documents/route.js
 *
 * GET /api/documents
 *
 * Returns all PDFs from storage, enriched with registry data.
 * The frontend uses this to know which files are already indexed
 * (and can use their docId immediately) vs which need indexing.
 *
 * Response:
 *   {
 *     source: "local",
 *     label:  "Local · /pdfs/",
 *     files: [
 *       {
 *         name:      "H0976-001-000.pdf",
 *         size:      5570560,
 *         docId:     "f3a2b1c4-...",   ← from registry (already indexed)
 *         nodeCount: 343,
 *         indexed:   true
 *       },
 *       {
 *         name:    "new-plan.pdf",
 *         size:    168432,
 *         docId:   null,               ← not in registry yet
 *         indexed: false
 *       }
 *     ]
 *   }
 */

import { NextResponse }              from 'next/server';
import { listPdfs, getStorageInfo }  from '@/lib/pdfStorage';
import { readRegistry }              from '@/lib/indexRegistry';

// Always fetch live data from R2 — never serve a build-time cached snapshot.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [files, registry, source] = await Promise.all([
      listPdfs(),
      readRegistry(),
      Promise.resolve(getStorageInfo()),
    ]);

    // Enrich each file with its registry entry if one exists
    const enriched = files.map(f => {
      const entry = registry[f.name];
      return {
        name:      f.name,
        size:      f.size,
        docId:     entry?.docId     || null,
        nodeCount: entry?.nodeCount || 0,
        indexedAt: entry?.indexedAt || null,
        indexed:   !!entry?.docId,
      };
    });

    return NextResponse.json({ ...source, files: enriched });
  } catch (err) {
    console.error('[documents] error:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to list documents.' },
      { status: 500 }
    );
  }
}
