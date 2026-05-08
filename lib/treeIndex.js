/**
 * lib/treeIndex.js
 *
 * Storage layer for PageIndex tree results + retrieval helpers.
 *
 * ─── What changed for performance ────────────────────────────────────────────
 *
 * OLD: buildNodeDirectory() relied on node.summary (AI-generated at index time)
 *      → required addNodeSummary: true → N/5 sequential LLM batches at upload
 *
 * NEW: buildNodeDirectory() uses the first 300 chars of node.text instead
 *      → addNodeSummary can be false → zero extra LLM calls at upload
 *      → text previews are actually MORE useful for retrieval:
 *        summaries can be vague ("discusses coverage") while text is direct
 *
 * ─── PageIndex library functions used ────────────────────────────────────────
 *
 *   getNodes(structure)      → flattens entire tree to flat array (all levels)
 *   getLeafNodes(structure)  → flattens to only deepest nodes (no children)
 *
 * ─── Storage schema ──────────────────────────────────────────────────────────
 *
 *   /tmp/hw-tree-index/<docId>.json
 *   {
 *     docId, filename, docName, structure: TreeNode[],
 *     nodeCount, leafCount, createdAt
 *   }
 */

import fs   from 'fs';
import path from 'path';
import { getNodes, getLeafNodes } from 'pageindex';

const INDEX_DIR = path.join('/tmp', 'hw-tree-index');

function ensureDir() {
  if (!fs.existsSync(INDEX_DIR)) fs.mkdirSync(INDEX_DIR, { recursive: true });
}
const filePath = docId => path.join(INDEX_DIR, `${docId}.json`);

// ─── Persist ─────────────────────────────────────────────────────────────────

/**
 * Save a PageIndexResult to disk.
 *
 * @param {string} docId
 * @param {string} filename
 * @param {PageIndexResult} result  — from PageIndex.fromPdf()
 */
export function saveTreeIndex(docId, filename, result) {
  ensureDir();
  const allNodes  = getNodes(result.structure);
  const leafNodes = getLeafNodes(result.structure);
  const payload = {
    docId,
    filename,
    docName:   result.docName,
    structure: result.structure,
    nodeCount: allNodes.length,
    leafCount: leafNodes.length,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath(docId), JSON.stringify(payload), 'utf8');
  return payload;
}

// ─── Load ─────────────────────────────────────────────────────────────────────

/**
 * Load a stored tree index from /tmp (local cache only — fast, synchronous).
 * @returns {object|null}
 */
export function loadTreeIndex(docId) {
  const p = filePath(docId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

// ─── Vercel Blob persistence (cross-instance storage) ────────────────────────
//
// On Vercel, each serverless invocation may run on a different compute instance
// with its own empty /tmp. Tree indices saved by /api/index-pdf are NOT visible
// to a subsequent /api/chat request that lands on a different instance.
//
// Fix: also persist tree indices to Vercel Blob (shared across all instances).
// /tmp acts as an instance-local cache — fast on warm instances, falls back to
// Blob on cold starts.
//
const R2_INDEX_PREFIX = 'hw-tree-index/';

/**
 * Save the tree index payload to R2 (no-op on local dev).
 * Call this after saveTreeIndex() so the data is available cross-instance.
 *
 * @param {string} docId
 * @param {object} payload  — the object returned by saveTreeIndex()
 */
export async function saveTreeIndexToBlob(docId, payload) {
  if (process.env.PDF_SOURCE !== 'r2') return;
  try {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const { getR2Client, getR2Bucket } = await import('./r2Client.js');
    await getR2Client().send(new PutObjectCommand({
      Bucket:      getR2Bucket(),
      Key:         `${R2_INDEX_PREFIX}${docId}.json`,
      Body:        JSON.stringify(payload),
      ContentType: 'application/json',
    }));
  } catch (err) {
    console.warn('[treeIndex] R2 save failed:', err.message);
  }
}

/**
 * Ensure the tree index is in /tmp — fetches from R2 if not cached locally.
 * After this returns, loadTreeIndex(docId) will succeed (or the index doesn't exist).
 *
 * @param {string} docId
 */
export async function ensureTreeIndex(docId) {
  const p = filePath(docId);
  if (fs.existsSync(p)) return;                    // already in /tmp — fast path
  if (process.env.PDF_SOURCE !== 'r2') return;     // local dev: /tmp is persistent
  try {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getR2Client, getR2Bucket, streamToBuffer } = await import('./r2Client.js');
    const resp = await getR2Client().send(new GetObjectCommand({
      Bucket: getR2Bucket(),
      Key:    `${R2_INDEX_PREFIX}${docId}.json`,
    }));
    const text = (await streamToBuffer(resp.Body)).toString('utf8');
    ensureDir();
    fs.writeFileSync(p, text, 'utf8');
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return;
    console.warn('[treeIndex] ensureTreeIndex failed:', err.message);
  }
}

// ─── Flatten helpers ──────────────────────────────────────────────────────────

/** All nodes (every level). Wraps pageindex getNodes(). */
export function flattenAllNodes(structure) {
  return getNodes(structure);
}

/** Only leaf nodes (deepest sections). Wraps pageindex getLeafNodes(). */
export function flattenLeafNodes(structure) {
  return getLeafNodes(structure);
}

// ─── Node directory for LLM selection step ───────────────────────────────────

/**
 * Build a compact directory string used in Step 1 (node selection).
 *
 * FORMAT:
 *   [nodeId] pp.N–M | Section title — first 300 chars of raw text
 *
 * WHY TEXT PREVIEW INSTEAD OF AI SUMMARY:
 *   • addNodeSummary was the single biggest upload bottleneck:
 *     N nodes / batchSize 5 = N/5 sequential round-trips to OpenAI
 *   • Text previews are generated locally (zero API calls)
 *   • Raw text previews are often MORE specific than vague AI summaries
 *     e.g. "D0120 – Periodic Oral Evaluation 80% in-network..." beats
 *          "This section discusses evaluation coverage"
 *   • At query time the LLM does the semantic matching anyway
 *
 * @param {TreeNode[]} nodes  — from flattenAllNodes()
 * @param {number}     max    — cap at this many nodes (default 80)
 */
export function buildNodeDirectory(nodes, max = 80) {
  return nodes
    .filter(n => n.text && n.text.length > 30)
    .slice(0, max)
    .map(n => {
      const pages = (n.startIndex != null && n.endIndex != null)
        ? `pp.${n.startIndex}–${n.endIndex}`
        : '';

      // Use full text cleaned up — 600 chars gives much better coverage
      // for dense benefits/cost tables where service names appear mid-page.
      // 300 chars was the root cause of missing "Acupuncture" entries that
      // appeared after the first few lines of a page.
      const preview = n.summary
        ? n.summary.slice(0, 500).replace(/\n/g, ' ')
        : n.text.replace(/\s+/g, ' ').slice(0, 600);

      return `[${n.nodeId ?? '?'}] ${pages} | ${n.title} — ${preview}`;
    })
    .join('\n');
}

// ─── Keyword pre-filter (solves the 332-page problem) ────────────────────────

/**
 * Extract meaningful keywords from a user question.
 * Strips stopwords and short words, keeps specific terms.
 *
 * @param {string} query
 * @returns {string[]}
 */
export function extractKeywords(query) {
  // Generic healthcare words that appear on nearly every page — exclude from scoring
  const STOPWORDS = new Set([
    'what','is','the','a','an','for','of','in','on','at','to','and','or',
    'does','do','did','are','was','were','be','been','being','have','has',
    'had','will','would','could','should','can','may','might','with','from',
    'this','that','these','those','it','its','how','much','many','any','all',
    'give','me','tell','show','find','get','list','please','about','which',
    // Healthcare-specific generic words — on nearly every page, useless for scoring
    'care','services','service','plan','covered','coverage','benefit','benefits',
    'health','medical','information','regarding','details',
    'patient','provider','member','you','your','pay','paying','paid',
  ]);
  return query
    .toLowerCase()
    .replace(/[*()[\]?/\\]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Three-tier keyword search — solves both the 80-node cap AND the generic-word problem.
 *
 * WHY "Pediatric Subacute Care" failed and "Outpatient surgery" worked:
 *   - "care" appears hundreds of times in a 343-page benefits doc
 *   - Old scoring: pages with lots of "care" outranked the actual table entry page
 *   - "outpatient" + "surgery" are specific enough that the right page scored highest
 *
 * NEW SCORING (three tiers):
 *   Tier 1 — Exact phrase match:  score += 1000  (e.g. "pediatric subacute care" verbatim)
 *   Tier 2 — All keywords present: score += 100  (every keyword on same page)
 *   Tier 3 — Individual frequency: score += count (base frequency score)
 *
 * PLUS neighbor pages: once the exact match page is found, include pages ±2
 * because benefits table entries often span across a page boundary.
 *
 * @param {TreeNode[]} nodes   — all nodes from flattenAllNodes()
 * @param {string}     query   — raw user question
 * @param {number}     limit   — max candidates to return (default 40)
 * @returns {TreeNode[]}
 */
export function keywordSearch(nodes, query, limit = 40) {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return nodes.slice(0, limit);

  // Exact phrase from cleaned query — used for Tier 1 matching
  const exactPhrase = query.toLowerCase().replace(/[*()[\]?/\\]/g, ' ').replace(/\s+/g, ' ').trim();
  const keyPhrase   = keywords.join(' ');

  const scored = nodes.map(node => {
    const text = (node.text || '').toLowerCase();
    let score = 0;

    // Tier 1: exact full phrase match — massive boost
    if (exactPhrase.length > 4 && text.includes(exactPhrase)) score += 1000;
    // Tier 1b: keyword-phrase match (stopwords removed)
    if (keyPhrase.length > 4 && keyPhrase !== exactPhrase && text.includes(keyPhrase)) score += 500;
    // Tier 2: all keywords present on same page
    if (keywords.length > 1 && keywords.every(kw => text.includes(kw))) score += 100;
    // Tier 3: individual keyword frequency
    score += keywords.reduce((total, kw) => {
      let count = 0, pos = 0;
      while ((pos = text.indexOf(kw, pos)) !== -1) { count++; pos++; }
      return total + count;
    }, 0);

    return { node, score };
  });

  const ranked = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return nodes.slice(0, limit);

  // Include neighbor pages (±2) for top matches — table entries span page boundaries
  const top       = ranked.slice(0, 15);
  const nodeMap   = new Map(nodes.map(n => [parseInt(n.nodeId, 10), n]));
  const seen      = new Set();
  const result    = [];

  const add = node => {
    if (node && !seen.has(node.nodeId)) { seen.add(node.nodeId); result.push(node); }
  };

  top.forEach(({ node }) => {
    add(node);
    const id = parseInt(node.nodeId, 10);
    if (!isNaN(id)) [-2,-1,1,2].forEach(d => add(nodeMap.get(id + d)));
  });

  ranked.slice(15).forEach(({ node }) => { if (result.length < limit) add(node); });

  return result.slice(0, limit);
}

/**
 * Return full text for the node IDs chosen by the selection step.
 *
 * @param {TreeNode[]} nodes    — flattenAllNodes() result
 * @param {string[]}   nodeIds  — IDs returned by gpt-4o-mini
 * @returns {Array<{nodeId, title, pages, text}>}
 */
export function getNodeContents(nodes, nodeIds) {
  const idSet = new Set(nodeIds.map(String));
  return nodes
    .filter(n => n.nodeId && idSet.has(String(n.nodeId)) && n.text)
    .map(n => ({
      nodeId: n.nodeId,
      title:  n.title,
      pages:  n.startIndex != null ? `${n.startIndex}–${n.endIndex}` : '',
      text:   n.text,
    }));
}

// ─── Snippet extractor (fixes multi-column table problem) ─────────────────────

/**
 * WHY THIS IS NEEDED:
 * pdf-parse extracts multi-column benefit tables in column-by-column order:
 *
 *   Column 1 (all service names):
 *     "...Optometry Services Organized Outpatient Clinic Services
 *      Outpatient Heroin Detoxification..."
 *
 *   Column 2 (all Medi-Cal costs — MUCH LATER IN TEXT):
 *     "$0 for Medi-Cal-covered $0 for Medi-Cal-covered..."
 *
 *   Column 3 (all plan costs — EVEN LATER):
 *     "You pay $0 You pay $0..."
 *
 * When GPT-4o receives the full page text, "Organized Outpatient Clinic Services"
 * and its cost "$0" are hundreds of characters apart — the model can't associate them.
 *
 * SOLUTION — extractSnippets():
 *   1. Find every position where query keywords appear in the page text
 *   2. Extract a 600-char window (±300) around each match
 *   3. Return these focused windows as the primary context
 *   4. Append full text as a fallback section
 *
 * GPT-4o now sees the service name + the surrounding text (which includes
 * the adjacent column's cost info in row-by-row extraction, OR
 * at minimum the service name clearly highlighted in column-by-column extraction).
 *
 * @param {Array<{nodeId, title, pages, text}>} nodes  — from getNodeContents()
 * @param {string} query   — user question
 * @param {number} window  — chars each side of match (default 350)
 * @returns {string}       — formatted context string for GPT-4o
 */
export function extractSnippets(nodes, query, window = 350) {
  const keywords = extractKeywords(query);
  const exactPhrase = query.toLowerCase().replace(/[*()[\]?/\\]/g, ' ').replace(/\s+/g, ' ').trim();

  const parts = [];

  nodes.forEach(node => {
    const text     = node.text || '';
    const textLow  = text.toLowerCase();
    const header   = `\n--- ${node.title}${node.pages ? ` (pp.${node.pages})` : ''} ---`;

    // Collect all match positions (exact phrase first, then individual keywords)
    const positions = new Set();

    // Exact phrase matches
    let pos = 0;
    while ((pos = textLow.indexOf(exactPhrase, pos)) !== -1) {
      positions.add(pos); pos++;
    }

    // Individual keyword matches
    keywords.forEach(kw => {
      let p = 0;
      while ((p = textLow.indexOf(kw, p)) !== -1) {
        positions.add(p); p++;
      }
    });

    if (positions.size === 0) {
      // No keyword hit — include full text as-is (fallback)
      parts.push(`${header}\n${text}`);
      return;
    }

    // Build non-overlapping windows around each match position
    const ranges = [];
    [...positions].sort((a, b) => a - b).forEach(p => {
      const start = Math.max(0, p - window);
      const end   = Math.min(text.length, p + window);
      // Merge with previous range if overlapping
      if (ranges.length && start <= ranges[ranges.length - 1][1]) {
        ranges[ranges.length - 1][1] = Math.max(end, ranges[ranges.length - 1][1]);
      } else {
        ranges.push([start, end]);
      }
    });

    // Build the snippet text
    const snippets = ranges
      .slice(0, 6)  // max 6 windows per page
      .map(([s, e]) => {
        const prefix = s > 0 ? '…' : '';
        const suffix = e < text.length ? '…' : '';
        return `${prefix}${text.slice(s, e).replace(/\s+/g, ' ')}${suffix}`;
      })
      .join('\n\n');

    // Include both snippets AND full text so GPT-4o can cross-reference
    parts.push(`${header}\n[RELEVANT EXCERPTS]\n${snippets}\n\n[FULL PAGE TEXT]\n${text}`);
  });

  return parts.join('\n');
}
