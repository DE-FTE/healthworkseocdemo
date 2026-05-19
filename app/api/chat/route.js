/**
 * app/api/chat/route.js
 *
 * POST /api/chat
 * Body: { message, docIds: string[], history }
 *
 * ─── Three-phase pipeline ─────────────────────────────────────────────────────
 *
 * PHASE 0 — Query rewriting + classification (1 gpt-4o-mini call)
 *   Raw message → clean search query + query type (plan_info | benefit | general)
 *   - plan_info:  service area, eligibility, contact, plan overview
 *   - benefit:    costs, copayments, specific service coverage
 *   - general:    everything else
 *
 * PHASE 1 — Local doc pre-filtering (ZERO API calls, handles 1000+ docs)
 *   keywordSearch() on ALL doc indices locally → score each doc
 *   For plan_info queries → ALL docs pass (intro pages always relevant)
 *   For benefit queries  → only docs with keyword score > 0 pass
 *   Result: top N relevant docs (default 10 max), not all 1000
 *
 * PHASE 2 — Per-doc node selection (1 gpt-4o-mini call per filtered doc)
 *   For plan_info:  force-retrieve intro pages 1-30, skip gpt-4o-mini selection
 *   For benefit:    keyword candidates + anchor pages → gpt-4o-mini selection
 *   Only runs for filtered docs (not all 1000)
 *
 * PHASE 3 — Answer generation (1 gpt-4o stream call)
 *   Combined context from all relevant docs → streamed answer
 */

import OpenAI from 'openai';
import {
  loadTreeIndex,
  ensureTreeIndex,
  flattenAllNodes,
  buildNodeDirectory,
  getNodeContents,
  keywordSearch,
  extractSnippets,
} from '@/lib/treeIndex';

// Lazy singleton — instantiated on first request, not at build time.
// This prevents "missing OPENAI_API_KEY" errors during next build.
let _openai = null;
const getOpenAI = () => {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
};

const SELECT_MODEL      = process.env.SELECTION_MODEL      || 'gpt-4o-mini';
const ANSWER_MODEL      = process.env.ANSWER_MODEL          || 'gpt-4o';
const MAX_NODES_PER_DOC = parseInt(process.env.MAX_NODES_PER_QUERY || '6', 10);
// 6 nodes per doc — restored to richer context now that smart filtering reduces doc count
const MAX_DOCS_TO_QUERY = parseInt(process.env.MAX_DOCS_TO_QUERY   || '5', 10);
// Max 5 docs — but smart scoring means specific queries only hit 2-3 docs anyway
const MAX_CONTEXT_CHARS = parseInt(process.env.MAX_CONTEXT_CHARS   || '75000', 10);
// 75k chars ≈ 22k context tokens. System prompt (incl. extraction guide + category instructions)
// adds ~2.5k tokens; history ~1k; max_tokens 3k → ~28.5k total, safely under 30k TPM limit.
// Reduced from 90k after adding the General Extraction Guide expanded the system prompt by ~700 tokens.

// ─── PHASE 0: Query rewriting + type classification ───────────────────────────

/**
 * Returns { searchQuery, queryType, docTargets }
 *
 * queryType:
 *   'plan_info' → service area, eligibility, plan overview, contact info
 *                 Strategy: force-retrieve intro pages 1-30
 *   'benefit'   → costs, copayments, specific service/procedure coverage
 *                 Strategy: keyword search → node selection
 *   'general'   → everything else, treat like benefit
 *
 * docTargets: filenames explicitly mentioned in query (empty = all docs)
 */
async function analyzeQuery(message, history = []) {
  // Only include user messages — AI response body is never needed to extract searchQuery,
  // queryType, or docTargets, and including it caused topic contamination (e.g. an AI
  // response beginning "here is the exclusion data..." caused GPT to inherit "exclusions"
  // as the topic for the next query even when the user explicitly asked about "usage limits").
  const recentCtx = history
    .filter(m => m.role === 'user')
    .slice(-3)
    .map(m => `User: ${m.content.slice(0, 300)}`)
    .join('\n');

  const prompt =
`You are a query analyzer for a healthcare benefits RAG system.
Given a user message (which may be a follow-up to a prior conversation), return a JSON object with exactly these fields:

{
  "searchQuery": "3-8 keyword search terms (strip conversational filler, keep medical/benefit terms)",
  "queryType": "plan_info" | "benefit" | "general",
  "docTargets": ["filename1", "filename2"]
}

queryType rules:
- "plan_info": service area, counties, eligibility, enrollment, plan overview, contact numbers, member ID
- "benefit": costs, copayment, coinsurance, coverage, deductible, specific procedure/service names
- "general": comparisons, summaries, multiple topics

docTargets: list ONLY the EXACT document filenames/IDs as they appear verbatim in the conversation (e.g. "H0523-074-000"). If the user refers to a plan by name only (e.g. "Aetna Medicare Value Plus") without stating a filename, return an empty array — do NOT guess or infer a filename. Never include partial matches.
PRIORITY RULE: If the current message explicitly names a benefit/service (e.g. "Dental", "OTC") AND an attribute (e.g. "usage limits", "exclusions", "copay", "allowance", "coverage"), ALWAYS derive searchQuery from THOSE exact terms. Do NOT inherit topic or attribute from a previous AI response.
SCOPE RULE: If the current message contains "plans in scope", "all plans", "plans mentioned", "for all plans", "the plans in scope", "plans mentioned in scope", or any phrase meaning all selected plans, return docTargets as [] — do NOT inherit from previous messages even if a previous message named a specific document.
FOLLOW-UP RULE: If the current message uses "it", "same", "above", "that", "those", "the above", or does not name specific documents AND does not trigger the SCOPE RULE, INHERIT the docTargets from the most recent user message in the conversation that DID name documents.
FORMAT RULE: If the current message is a format/display request ("show as table", "display as chart", "convert to pie"), extract the TOPIC keywords from the previous user question, not from the format instruction itself.

${recentCtx ? `Recent conversation:\n${recentCtx}\n\n` : ''}User message: "${message}"

Return ONLY the JSON object, no explanation.`;

  try {
    const resp = await getOpenAI().chat.completions.create({
      model: SELECT_MODEL, max_tokens: 120, temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw  = resp.choices[0].message.content.trim();
    const json = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return {
      searchQuery: json.searchQuery || message,
      queryType:   ['plan_info','benefit','general'].includes(json.queryType) ? json.queryType : 'general',
      docTargets:  Array.isArray(json.docTargets) ? json.docTargets : [],
    };
  } catch {
    return { searchQuery: message, queryType: 'general', docTargets: [] };
  }
}

// ─── Multi-benefit term extractor ─────────────────────────────────────────────

/**
 * When a user asks for multiple benefits in one query (e.g. "[ Acupuncture Copay,
 * Podiatry Copay, Emergency Care Copay, Chiropractic services copay ]"), a single
 * combined keyword search dilutes results and 6 nodes can't cover 4 separate
 * benefit pages. This extracts the individual terms so each gets its own keyword pass.
 */
function extractBenefitTerms(message) {
  // Pattern 1: explicit bracket list  [ term1, term2, ... ]
  const bracketMatch = message.match(/\[([^\]]{10,})\]/);
  if (bracketMatch) {
    const terms = bracketMatch[1].split(',').map(t => t.trim()).filter(t => t.length > 2);
    if (terms.length > 1) return terms;
  }

  // Pattern 2: 3+ comma-separated phrases each containing a benefit signal word
  const BENEFIT_WORD = /\b(copay|copayment|coinsurance|deductible|coverage|service|benefits?\b|cost)\b/i;
  const parts = message.split(/,\s*(?:and\s+)?/).map(t => t.trim());
  if (parts.length >= 3) {
    const hits = parts.filter(t => t.length > 4 && t.length < 80 && BENEFIT_WORD.test(t));
    if (hits.length >= 3) return hits;
  }

  // Pattern 3: 2+ healthcare service names anywhere in the query's leading clause,
  // separated by commas, "and", spaces, or any order relative to attribute words.
  // Uses a global scan so it catches "Dental Vision and Hearing" (no commas)
  // just as reliably as "Dental, Vision, Hearing Exclusions" (with commas).
  // This is intentionally attribute-agnostic — exclusion/copay/allowance/etc. in
  // any position are ignored; only the service names determine multi-benefit mode.
  const HEALTHCARE_SERVICES_RE = /\b(dental|vision|hearing|otc|over.the.counter|flex\s*card|pharmacy|chiropractic|acupuncture|podiatry|physical\s*therapy|mental\s*health|transportation|fitness|hospice|skilled\s*nursing|urgent\s*care|emergency|inpatient|outpatient|meals?|grocery|groceries)\b/gi;
  const leadingClause = message.split(/\binclude\s+in\s+a\b|\bprovide:|\balso\s+provide\b|\* /i)[0].trim();
  if (leadingClause.length > 0) {
    const serviceNamesFound = [];
    const svcRe = new RegExp(HEALTHCARE_SERVICES_RE.source, 'gi');
    let svcMatch;
    while ((svcMatch = svcRe.exec(leadingClause)) !== null) {
      const svc = svcMatch[1].toLowerCase().replace(/\s+/g, ' ');
      if (!serviceNamesFound.includes(svc)) serviceNamesFound.push(svc);
    }
    if (serviceNamesFound.length >= 2) return serviceNamesFound;
  }

  return [];
}

// ─── PHASE 1: Local doc pre-filtering (zero API calls) ────────────────────────

/**
 * HOW THIS WORKS (same concept as embedding-based retrieval, no vectors):
 *
 *   Embeddings RAG:   embed query → cosine similarity vs stored vectors → top K docs
 *   Our approach:     keyword score query → BM25-style scoring vs stored text → top K docs
 *
 * Both achieve the same goal: find the most relevant documents before any API call.
 * The docId in .registry.json = collection ID in a VectorDB.
 * The page text in /tmp = the embedded chunks in a VectorDB.
 *
 * SCORING:
 *   For each doc, run keywordSearch() on its full page index (local, zero API calls).
 *   Score = sum of (keyword hits × position weight) across top matching pages.
 *   Only docs with score above threshold pass to the expensive API steps.
 *
 *   This means for 9 docs:
 *     "Podiatry costs" → only 2-3 docs that actually mention podiatry pass
 *     "Service area"   → all docs pass (every healthcare doc has service area)
 *     "Hey how are you"→ caught by conversational bypass before this runs
 *
 * RESULT: gpt-4o-mini selection runs on 2-3 relevant docs, not all 9.
 * Token usage drops from 34,000 to ~8,000 for specific queries.
 */
function filterRelevantDocs(loadedDocs, searchQuery, queryType, docTargets) {
  // Returns { docs: [...], missingDocs: [...] }
  // missingDocs = names the user asked for that aren't loaded
  // Caller checks missingDocs and returns a helpful error to the user
  // ── Named doc targeting — EXACT match only ────────────────────────────────
  //
  // WHY EXACT: partial/stem matching caused "H1822-001-000" to also match
  // H1822-002-000, H1822-006-000, H1822-007-000 because they all share "h1822".
  //
  // Strategy (three levels, first match wins):
  //   1. Full stem exact match: "h1822-001-000" === "h1822-001-000" ✓
  //   2. Full name in query:    query contains "h1822-001-000" verbatim ✓
  //   3. Docname in target:     target "H1822-001-000" is in doc filename ✓
  // No partial prefix matching — "h1822" alone never matches anything.
  //
  if (docTargets.length > 0) {
    const targeted = loadedDocs.filter(doc => {
      const stem     = doc.filename.toLowerCase().replace(/\.pdf$/i, '');
      const filename = doc.filename.toLowerCase();
      return docTargets.some(t => {
        const tl   = t.toLowerCase().replace(/\.pdf$/i, '');
        // Exact stem match
        if (stem === tl) return true;
        // Full filename contains the target exactly (handles .pdf suffix)
        if (filename === tl || filename === tl + '.pdf') return true;
        // Target contains the full stem (user typed partial but specific enough)
        if (tl.includes(stem) && stem.length >= 8) return true;
        // Stem contains the full target (target is substring of longer filename)
        if (stem.includes(tl) && tl.length >= 8) return true;
        return false;
      });
    });
    // Check which requested docs were NOT found — tell user instead of silently ignoring
    const missingDocs = docTargets.filter(t => {
      const tl = t.toLowerCase().replace(/\.pdf$/i, '');
      return !loadedDocs.some(doc => {
        const stem = doc.filename.toLowerCase().replace(/\.pdf$/i, '');
        return stem === tl || stem.includes(tl) && tl.length >= 8 || tl.includes(stem) && stem.length >= 8;
      });
    });

    if (targeted.length > 0) return { docs: targeted, missingDocs };
    // All named docs are missing — return error info
    return { docs: [], missingDocs: docTargets };
  }

  // ── Score every doc locally (zero API calls) ──────────────────────────────
  const scored = loadedDocs.map(doc => {
    const allNodes = flattenAllNodes(doc.stored.structure)
      .filter(n => n.text && n.text.length > 50);

    // Get top 10 matching pages for this doc
    const topMatches = keywordSearch(allNodes, searchQuery, 10);
    if (topMatches.length === 0) return { doc, score: 0 };

    // Score = number of matching pages × a boost if top match has exact phrase
    const exactPhrase = searchQuery.toLowerCase().replace(/\s+/g, ' ').trim();
    const topText     = (topMatches[0].text || '').toLowerCase();
    const exactBoost  = topText.includes(exactPhrase) ? 10 : 0;
    const score       = topMatches.length + exactBoost;

    return { doc, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // plan_info: always take top MAX_DOCS (service area exists in every doc)
  if (queryType === 'plan_info') {
    return { docs: scored.slice(0, MAX_DOCS_TO_QUERY).map(s => s.doc), missingDocs: [] };
  }

  // benefit/general: only include docs with score > 0 (actually have the content)
  const relevant = scored.filter(s => s.score > 0);

  // If NO doc has keyword hits → fall back to top MAX_DOCS (prevents empty results)
  const pool = relevant.length > 0 ? relevant : scored;

  return { docs: pool.slice(0, MAX_DOCS_TO_QUERY).map(s => s.doc), missingDocs: [] };
}

// ─── PHASE 2a: Force-retrieve intro pages (plan_info queries) ─────────────────

/**
 * For plan_info queries (service area, eligibility etc):
 * Instead of keyword selection, directly retrieve the first 30 pages.
 * These pages ALWAYS contain plan overview info in healthcare benefit docs.
 * No gpt-4o-mini selection needed — we retrieve all intro pages directly.
 */
function getIntroPagesForDoc(stored) {
  const allNodes = flattenAllNodes(stored.structure)
    .filter(n => n.text && n.text.length > 50);
  // Get first 30 pages directly — no selection step
  return getNodeContents(allNodes, allNodes.slice(0, 30).map(n => String(n.nodeId)));
}

// ─── Synonym map — shared between main and retry paths ───────────────────────
// Plans use wildly different section titles for the same benefit.
//   "Vision" → "Routine Vision Services", "Eye Care", "Optometric Services"
//   "Hearing" → "Audiologic Services", "Hearing Aid Fitting", "Routine Hearing"
const BENEFIT_SYNONYMS = {
  dental:             ['dental', 'oral', 'teeth cleaning', 'fluoride', 'oral exam', 'routine dental'],
  vision:             ['vision', 'eye exam', 'optometric', 'optometry', 'eye care', 'routine vision', 'optic', 'spectacle'],
  hearing:            ['hearing', 'hearing aid', 'audiolog', 'routine hearing', 'auditory', 'audiometric'],
  otc:                ['otc', 'over-the-counter', 'over the counter'],
  'flex card':        ['flex card', 'flex benefit', 'allowance card', 'supplemental benefit'],
  pharmacy:           ['pharmacy', 'prescription drug', 'drug coverage'],
  chiropractic:       ['chiropractic', 'chiropractor', 'spinal manipulation'],
  acupuncture:        ['acupuncture'],
  podiatry:           ['podiatry', 'foot care', 'routine foot'],
  'physical therapy': ['physical therapy', 'physiotherapy'],
  'mental health':    ['mental health', 'behavioral health', 'psychiatric'],
  transportation:     ['transportation', 'medical transport', 'non-emergency transport'],
  fitness:            ['fitness', 'gym membership', 'exercise benefit'],
  meal:               ['meal', 'meals', 'post-discharge meal', 'post discharge meal', 'home delivered meal', 'freshly prepared meal', 'frozen meal', 'nutritional shake'],
  meals:              ['meal', 'meals', 'post-discharge meal', 'post discharge meal', 'home delivered meal', 'freshly prepared meal', 'frozen meal', 'nutritional shake'],
  grocery:            ['grocery', 'grocery allowance', 'grocery card', 'healthy food card', 'food allowance', 'food benefit', 'healthy food', 'produce'],
  groceries:          ['grocery', 'grocery allowance', 'grocery card', 'healthy food card', 'food allowance', 'food benefit', 'healthy food', 'produce'],
  emergency:          ['emergency', 'emergency room', 'emergency care', 'urgent care'],
  inpatient:          ['inpatient', 'hospital stay', 'hospitalization'],
  outpatient:         ['outpatient', 'ambulatory'],
};

// ─── Category detector — maps query to structured benefit schemas ─────────────
//
// Detects which of the 12 benefit categories (from schemas.py) are relevant to
// the current query. The detected list drives getCategoryInstructions() which
// injects per-category field guides into the Phase 3 system prompt.
const CATEGORY_PATTERNS = [
  { category: 'Dental',                   re: /\b(dental|oral|teeth|fluoride|cavity|filling|root canal|crown|orthodontic|periodon)\b/i },
  { category: 'Vision',                   re: /\b(vision|eye exam|optometric|optometry|eye care|eyewear|glasses|contacts|lenses|frames|spectacle)\b/i },
  { category: 'Hearing',                  re: /\b(hearing|hearing aid|audiolog|auditory|audiometric|ear exam|tinnitus|otc hearing)\b/i },
  { category: 'OTC/Flex Card',            re: /\b(otc|over.the.counter|flex card|flex benefit|healthy today|allowance card|supplemental card)\b/i },
  { category: 'Transportation',           re: /\b(transport|nemt|rideshare|medical transport|non.emergency|trip limit|mileage limit|ride)\b/i },
  { category: 'Fitness / Wellness',       re: /\b(fitness|gym|workout|silversneakers|silver.?fit|renew active|wellness|exercise|tivity health)\b/i },
  { category: 'Meals/Grocery',            re: /\b(meal|grocery|food|produce|post.discharge meal|home delivered|healthy food|grocery card)\b/i },
  { category: 'Alternative Therapies',    re: /\b(chiropractic|chiropractor|acupuncture|spinal manipulation|alternative therap|massage therap)\b/i },
  { category: 'In-Home Support / Safety', re: /\b(pers|in.home|home safety|personal emergency response|grab bar|shower chair|home health visit|personal care hour)\b/i },
  { category: 'Telehealth / Remote Tech', re: /\b(telehealth|telemedicine|virtual visit|virtual care|video visit|phone visit|remote tech|teladoc|amwell)\b/i },
  { category: 'Rewards & Incentives',     re: /\b(reward|incentive|healthy action|earn credit|wallet credit|member reward|points)\b/i },
  { category: 'SSBCI / VBID',            re: /\b(ssbci|vbid|chronically ill|chronic condition|value.based insurance|special supplement|primarily health)\b/i },
];

function detectBenefitCategories(message, searchQuery, benefitTerms = []) {
  const text = [message, searchQuery, ...benefitTerms].join(' ').toLowerCase();
  return CATEGORY_PATTERNS.filter(({ re }) => re.test(text)).map(({ category }) => category);
}

// ─── Category instructions builder — JS port of schemas.py get_category_instructions()
//
// For each detected category injects a precise field guide into the GPT-4o system
// prompt so the model knows exactly which fields to look for, their expected format,
// and when to say "Not specified" vs reporting a value.
//
// WHY THIS HELPS:
//   Without this, GPT-4o answers Vision queries as generic "coverage: yes, copay: $0"
//   and misses: eyewear_allowance, diabetic_eye_exam_copay, routine_eye_exam_visits,
//   eyewear_combined vs individual max, prior auth normalization rules, etc.
//   With this, GPT-4o knows the 13 Vision fields by name and scans for all of them.
function getCategoryInstructions(categories) {
  if (!categories || categories.length === 0) return '';

  const parts = [];

  if (categories.includes('Dental')) {
    parts.push(`
  DENTAL — look for ALL these fields; report each explicitly:
  • preventive_dental_financial_cap      → "amount=$X | period=<year|quarter|month> | type=<Annual_Max|Allowance|Schedule|Copay>"
  • comprehensive_dental_financial_cap   → same format
  • dental_financial_cap_structure       → "Combined – <note>" if one cap covers both; "Separate – <note>" if distinct caps exist
  • preventive_dental_max_coverage_amount    → "$X" amount only
  • comprehensive_dental_max_coverage_amount → "$X" amount only
  • prior_auth_required          → "Yes – <criteria>" or "No" (normalize any partial/conditional to "Yes – <criteria>")
  • frequency_limits             → compact string e.g. "Cleanings: 2/yr; Exams: 1/yr; X-rays: bitewing/12mo"
  • historical_records           → "C – <note>" | "NC – <note>" | "NS"
  • exclusions                   → short notes only — cosmetic, implants, waiting periods (NO C/NC/NS tokens here)
  • vendor_network               → exact vendor/network text (e.g. "Cigna Dental Allowance (DPPO)")
  • general_conditions           → short operational note (e.g. "Use DPPO network; provider bills plan; no carryover")
  KEY RULE: A single combined allowance covering both preventive+comprehensive → set cap_structure = "Combined – …" and both individual caps = null.`);
  }

  if (categories.includes('Vision')) {
    parts.push(`
  VISION — look for ALL these fields; report each explicitly:
  • vision_covered                           → "C" or "NC" + brief note
  • routine_eye_exam_copay                   → "$X per 12 mo" or "$X per visit"
  • diabetic_eye_exam_copay                  → "$X per period"
  • eyewear_allowance                        → "$X / year • frames+lenses OR contacts" (preserve either/or wording)
  • routine_eye_exam_visits                  → "1/yr", "2 per year", etc.
  • other_eye_exam_visits                    → N/period for glaucoma screening or other exam types if stated
  • eye_exams_max_coverage_amount            → "$X" amount only
  • eyewear_individual_max_coverage_amount   → "$X" for individual components (frames-only or lenses-only cap)
  • eyewear_combined_max_coverage_amount     → "$X" when frames+lenses/contacts share one pool
  • prior_auth_required          → "Yes – <criteria>" or "No" (normalize any conditional to "Yes – <criteria>")
  • referral_required            → "No" | "Partial" | "Yes" (null if not stated)
  • exclusions                   → short notes only (non-prescription eyewear, cosmetic tints, premium add-ons)
  • vendor                       → "EyeMed", "VSP", "Davis", "in-house", etc.
  KEY RULE: Eyewear allowance often covers EITHER frames+lenses OR contacts — always preserve the either/or wording.`);
  }

  if (categories.includes('Hearing')) {
    parts.push(`
  HEARING — look for ALL these fields; report each explicitly:
  • hearing_covered                      → "C" or "NC" + brief note
  • benefit_structure                    → one of: Allowance | Copay_by_Tier | Coinsurance | Schedule + short note
  • routine_hearing_exam_copay           → "$X per visit" or "$X per year (N/yr)"
  • advanced_premium_aids_cost_share     → if Copay_by_Tier: {"Standard":"$X","Premium":"$Y"}; if Allowance: "$X per ear / period"
  • otc_hearing_aid_allowance            → "$X / period • OTC only" if applicable
  • batteries_per_aid                    → integer (cells/aid) or "kit-based"
  • battery_supply_duration              → "48 months", "per 4 years"
  • trial_period                         → "60 days", etc.
  • warranty                             → "C • N yrs • repair + loss/damage" | "NC" | "NS"
  • hearing_exams_max_coverage_amount    → "$X" amount only
  • hearing_aids_max_coverage_amount     → "$X" amount only
  • otc_hearing_aids_max_coverage_amount → "$X" amount only
  • vendor_program                       → "TruHearing", "NationsHearing", "in-house"
  • exclusions                           → short notes (implants, cosmetic upgrades, OON vendor)
  KEY RULE: Hearing aids are often tiered (Standard / Advanced / Premium) with different cost shares per tier — report all tiers found.`);
  }

  if (categories.includes('OTC/Flex Card')) {
    parts.push(`
  OTC / FLEX CARD — look for ALL these fields; report each explicitly:
  • covered                      → "C" or "NC" + brief note
  • wallet_type                  → "OTC" or "Flex" + brief note
  • card_wallet_name             → exact member-facing name (e.g. "Cigna Healthy Today")
  • vendor                       → program admin (e.g. "InComm", "Solutran", "Service Center")
  • allowance_amount             → "$X" amount only
  • allowance_period             → "per month" | "per quarter" | "per year"
  • carryover_allowed            → "Y" | "N" | "NS" + note if exceptions apply
  • purchase_channels            → "online; phone; mail catalog; in-store"
  • network_requirement          → "Participating only" | "Any retailer"
  • funding_mechanism            → "Prepaid card" | "Barcode/Voucher" | "Catalog credit"
  • buying_limits                → e.g. "catalog ≤1 order/mo"
  • shipping_threshold           → {"Min_Order_Amount":"$X","Shipping_Covered":"Y/N"} or null
  • eligible_products            → short list (OTC meds, health supplies, excludes Part B/D)
  • product_list_ref             → URL or locator text to product catalog
  • otc_max_coverage_amount      → "$X" annual/period max
  KEY RULE: Note whether unused balance rolls over or expires at end of quarter/year — this is a key plan differentiator.`);
  }

  if (categories.includes('Transportation')) {
    parts.push(`
  TRANSPORTATION — look for ALL these fields; report each explicitly:
  • covered                          → "C" or "NC" + brief note
  • transport_type                   → "NEMT" | "Rideshare" | "Both" + note (taxi, van, medical transport, etc.)
  • rideshare_allowed                → "Y" | "N" | "NS"
  • vendor                           → "Modivcare", "in-house", etc.
  • copay                            → "$X per one-way trip" or "Y%"
  • trip_limit                       → "<N> / year • one-way" or "<N> / mo • round-trip"
  • mileage_limit_per_trip           → "<N> miles • one-way"
  • scheduling_window                → "<N> hours in advance"
  • cancelling_window                → "<N> hours before pickup"
  • geographic_limitation            → County / Sub-county / Zip/Radius / None + detail
  • wallet_funded_rides              → "C – <Wallet> • Funding: $X / period • Carryover: Y/N" | "NC" | "NS"
  • transport_max_coverage_amount    → "$X" amount only
  KEY RULE: Trip limits are usually stated as one-way trips, not round-trips — confirm which unit is used.`);
  }

  if (categories.includes('Fitness / Wellness')) {
    parts.push(`
  FITNESS / WELLNESS — look for ALL these fields; report each explicitly:
  • covered                          → "C" or "NC" + brief note
  • digital_fitness_platform         → "C • [app, portal, on-demand videos, phone/video/chat coaching]" | "NC" | "NS"
  • program_name                     → "SilverSneakers", "Silver&Fit", "Renew Active", etc.
  • vendor                           → "Tivity Health", "in-house", plan vendor wording
  • network_requirement              → "In-network only" | "OON reimbursed" | "Any"
  • gym_membership_included          → "C" | "NC" | "NS"
  • copay                            → "$0 per visit", "$25/month", "20%"
  • home_fitness_kit                 → "C – one kit/yr (wearable tracker, options)" | "NC" | "NS"
  • wellness_digital_credits         → "$X / period • Rollover: Y/N"
  • eligible_uses_credits            → short list (classes, devices, wellness store)
  • exclusions                       → non-standard services with added fees, etc.
  • general_conditions               → how to enroll, use partner gyms, etc.
  KEY RULE: Many plans have BOTH a gym membership AND a separate digital fitness platform — report both independently.`);
  }

  if (categories.includes('Meals/Grocery')) {
    parts.push(`
  MEALS / GROCERY — look for ALL these fields; report each explicitly:
  • covered                              → "C" or "NC" + brief note
  • grocery_allowance                    → "$X" amount only
  • allowance_period                     → "per month" | "per quarter" | "per year"
  • carryover_allowed                    → "Y" | "N" | "NS"
  • payment_method                       → "Prepaid card; Catalog/Shipment; Retail voucher/Barcode"
  • purchase_channels                    → "in-store; online; phone order; participating retailers"
  • eligible_food_items                  → short list (produce, pantry staples, excludes hot prepared foods)
  • wallet_name                          → member-facing label (e.g. "Healthy Food Card")
  • vendor                               → program admin (e.g. "Solutran")
  • post_discharge_meals_covered         → "C" | "NC" | "NS"
  • post_discharge_meals_count           → integer (meals per discharge/episode)
  • post_discharge_meals_window          → "within N days • up to M×/yr"
  • post_discharge_meals_copay           → "$X per episode" or "$0"
  • exclusions                           → e.g. "ER/observation/outpatient discharge not eligible"
  KEY RULE: Many plans have BOTH a grocery card allowance AND a separate post-discharge meals benefit — always report both.`);
  }

  if (categories.includes('Alternative Therapies')) {
    parts.push(`
  ALTERNATIVE THERAPIES — look for ALL these fields; report each explicitly:
  • chiropractic_covered                 → "Covered" | "Not Covered" + note
  • chiropractic_cost_share              → "$X copay per visit" or "Y% coinsurance"
  • chiropractic_visit_limit             → "<N> visits per year"
  • chiropractic_routine_care_visits     → "<N> per year" (routine care)
  • chiropractic_other_care_visits       → "<N> per year" (other/non-routine)
  • acupuncture_visits                   → "<N> per year"
  • chiropractic_max_coverage_amount     → "$X" amount only
  • acupuncture_max_coverage_amount      → "$X" amount only
  • combined_visit_cap                   → combined limit across therapies (e.g. "20/yr • [chiro, acupuncture, massage]")
  • network_requirement                  → "In-network only" | "OON reimbursed"
  • prior_auth                           → "No" | "Partial – <criteria>" | "Yes – <criteria>"
  • referral_required                    → "No" | "Yes – PCP referral required" | "Partial"
  KEY RULE: Check whether chiropractic and acupuncture share a combined visit pool or have separate independent limits.`);
  }

  if (categories.includes('In-Home Support / Safety')) {
    parts.push(`
  IN-HOME SUPPORT / SAFETY — look for ALL these fields; report each explicitly:
  • covered                              → "Covered" | "Not Covered"
  • pers_device_provided                 → "PERS provided" | "PERS rental available" | "Not provided"
  • installation_setup_covered           → "Installation covered" | "Member pays installation"
  • pers_monthly_monitoring_fee          → "$0/month", "$29.99/month", etc.
  • vendor_pers                          → "Lifeline", "Aloecare", "in-house"
  • home_health_visits_copay             → "$X per visit" or "Y%"
  • personal_care_hours                  → "20 hours/year", "8 hours/month"
  • home_safety_devices_allowance        → "$X allowance"
  • allowance_period                     → "per year" | "one-time"
  • safety_devices_list                  → "grab bars, shower chair, raised toilet seat"
  • bathroom_safety_devices              → specific bathroom device details
  • prior_auth                           → "No" | "Yes – for >$X devices or >N visits"
  KEY RULE: PERS (Personal Emergency Response System) monitoring is distinct from the home safety device allowance — report them separately.`);
  }

  if (categories.includes('Telehealth / Remote Tech')) {
    parts.push(`
  TELEHEALTH / REMOTE TECH — look for ALL these fields; report each explicitly:
  • covered                              → "Covered" | "Not Covered"
  • platform_vendor                      → "Teladoc", "Amwell", "in-house", etc.
  • network_requirement                  → "Plan platform only" | "Any in-network provider"
  • eligible_modalities                  → "video, phone, secure message"
  • modality_cost_share_rule             → e.g. "Phone = same as video; eVisit = $0"
  • virtual_pcp_copay                    → copay/coinsurance + period
  • virtual_specialist_copay             → copay/coinsurance
  • virtual_pt_st_copay                  → PT/ST virtual copay
  • virtual_health_coaching              → "Covered • phone, video, portal" or null
  • referral_required                    → "No" | "Yes – PCP referral required"
  • prior_auth                           → "No" | "Yes – beyond N visits"
  KEY RULE: Virtual PCP and virtual specialist usually have different copays — always report both separately.`);
  }

  if (categories.includes('Rewards & Incentives')) {
    parts.push(`
  REWARDS & INCENTIVES — look for ALL these fields; report each explicitly:
  • program_present              → "Covered" | "Not Covered"
  • program_name                 → "Healthy Actions", "Member Rewards", etc.
  • trigger_types                → list of activating actions (PCP visit, AWV, HRA completion, vaccinations)
  • per_activity_reward          → "$X per AWV" or {"HRA":"$5","PCP":"$10"}
  • annual_cap                   → "$X per year" or "No cap"
  • delivery_mode                → "card load", "wallet credit", "gift card catalog"
  • otc_wallet_funding           → "loads_to_OTC_card" | "separate_rewards_card" | "digital_points_only"
  • redemption_channels          → "OTC catalog, retail, online portal, gift card catalog"
  • vendor_platform              → "in-house", "Virgin Pulse", etc.
  • rollover_allowed             → "Yes" | "No" | "Not specified"
  KEY RULE: Rewards may load directly to the OTC card balance — check whether it is the same card or a separate wallet.`);
  }

  if (categories.includes('SSBCI / VBID')) {
    parts.push(`
  SSBCI / VBID — look for ALL these fields; report each explicitly:
  • covered                              → "Covered" | "Not Covered"
  • eligibility_criteria                 → targeting rules (e.g. "Diabetes diagnosis + PCP attestation")
  • verification_method                  → "claims-based" | "provider attestation" | "case management"
  • enrollment_process                   → steps to activate (referral, form, annual re-eval)
  • wallet_structure                     → "category wallets • monthly reload • carryover: No"
  • payment_delivery                     → "preloaded prepaid card" | "direct shipment" | "voucher/barcode"
  • vendor                               → "Solutran", "HealthyBenefits", "in-house"
  • food_grocery_allowance               → "$X / month • produce & pantry staples"
  • pest_control                         → "$X one-time • inspection + 1 treatment"
  • general_support_for_living           → "home modifications up to $X; taxi vouchers"
  • indoor_air_quality                   → "HEPA filter $X; HVAC cleaning $X max"
  • documentation_required               → "invoice + photo; clinician note optional"
  • exclusions                           → "no alcohol; landlord permission required for rental mod"
  • additional_health_benefits           → short list/dict of "benefit: $X / period" for other health-related items
  KEY RULE: SSBCI/VBID benefits are condition-targeted (not universal) — always state the eligibility condition alongside each dollar amount.`);
  }

  if (parts.length === 0) return '';

  return `──────────────────────────────────────────────────────────────────
CATEGORY-SPECIFIC EXTRACTION GUIDE
──────────────────────────────────────────────────────────────────
The query involves the following benefit category/categories. For each,
scan ALL provided document sections for the listed fields. Report EVERY
field explicitly — do not skip fields because they seem minor or unlikely.
Distinguish: null/not stated = "Not specified" | not covered = "Not covered" | present but unclear = quote the ambiguous text.
${parts.join('\n')}
──────────────────────────────────────────────────────────────────`;
}

// ─── PHASE 2b: Keyword selection (benefit queries) ────────────────────────────

async function selectNodesForDoc(stored, searchQuery, queryType = 'general', benefitTerms = [], docCount = 1) {
  const allNodes = flattenAllNodes(stored.structure)
    .filter(n => n.text && n.text.length > 50);
  if (allNodes.length === 0) return [];

  const isMultiBenefit = benefitTerms.length > 1;
  // Scale up node limit when querying 3+ docs simultaneously — each doc gets fewer retrieval
  // slots relative to a single-doc query, causing relevant pages to be pushed out.
  const baseLimit = docCount >= 3 ? Math.min(MAX_NODES_PER_DOC + 2, 10) : MAX_NODES_PER_DOC;
  const nodeLimit = isMultiBenefit
    ? Math.min(benefitTerms.length * 3, 12)
    : baseLimit;

  // ── Multi-benefit: bypass GPT selection entirely ──────────────────────────
  //
  // WHY bypass: when given 60 candidates to select 12 from, GPT over-selects
  // pages that mention multiple services (summary/intro pages) and silently
  // ignores single-service-specific pages. GPT selection is unreliable as a
  // "cover all N benefits equally" allocator.
  //
  // WHY multi-signal: different plans use different cost terminology:
  //   H0978 → "copayment: $0"    H0976 → "your cost: $0" or "cost sharing"
  // Searching only "Podiatry copayment" misses H0976-style pages.
  // Three passes per term (copayment → cost → bare) ensures maximum recall
  // regardless of how a specific plan phrases its benefits table.
  if (isMultiBenefit) {
    // Single-list retrieval, 6 pages per term.
    //
    // SEARCH ORDER IS THE KEY INSIGHT:
    //   Problem: copayment pages always outscore frequency pages, so a flat list
    //   ordered copayment-first fills all slots before frequency pages appear.
    //
    //   Fix: put `${syn} frequency exam` FIRST in allResults.
    //   "frequency exam" is a 3-keyword query — Tier-2 scoring (+100) fires only
    //   on pages that have ALL THREE of [benefit, frequency, exam]. Those are
    //   exactly the "1 exam every 12 months" or "2 hearing aids per year" pages.
    //   They surface at the top of this search and grab slot 1-2 before copayment
    //   pages from later searches can crowd them out.
    //
    //   For plans that put all info on one page (H0978 style), that page scores
    //   high in BOTH `frequency exam` AND `copayment` → still gets slot 1. ✓
    //   For plans with separate copay and frequency pages (H0976 style), the
    //   frequency page wins slot 1 from `frequency exam`, copay page wins slot 2
    //   from `copayment`. Both are included. ✓
    //
    // MAX_CONTEXT_CHARS raised to 120k so the per-doc budget (60k for 2 docs)
    // fits ~15-18 unique pages × ~3.5k chars without truncation.
    const pagesPerTerm = 6;
    const finalNodes = [];

    // Soft services (meals, grocery, fitness, transportation) use domain-specific
    // priority searches. The clinical "frequency exam" order is WRONG for these:
    //   "meal frequency exam" → dental/vision exam pages outscore meals pages because
    //   benefits charts accumulate huge "exam" counts, filling all 6 slots with wrong pages.
    // Domain-specific queries (e.g. "post discharge") use Tier-2 ALL-keywords scoring
    // (+100 when ALL keywords appear on the page) which reliably outranks any benefits
    // chart page that only mentions "post-discharge" once in passing.
    const SOFT_SERVICES = new Set(['meal', 'meals', 'grocery', 'groceries', 'fitness', 'transportation']);
    const SOFT_DOMAIN_SEARCHES = {
      meal:           ['post discharge', 'post-discharge meal', 'home delivered meal'],
      meals:          ['post discharge', 'post-discharge meal', 'home delivered meal'],
      grocery:        ['grocery allowance', 'grocery card', 'healthy food card'],
      groceries:      ['grocery allowance', 'grocery card', 'healthy food card'],
      fitness:        ['fitness benefit', 'gym membership', 'exercise program'],
      transportation: ['trip limit', 'nemt transport', 'one way trip'],
    };

    for (const term of benefitTerms) {
      const key = term.toLowerCase().replace(/\s+/g, ' ').trim();
      const coreTerm = key
        .replace(/\s*(copay|copayment)\s*$/i, '')
        .replace(/\bservices?\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      const synList = BENEFIT_SYNONYMS[key] || BENEFIT_SYNONYMS[coreTerm] || [coreTerm];

      const allResults = [];
      if (SOFT_SERVICES.has(key)) {
        // Domain-specific priority searches first (high precision, no false positives)
        for (const q of (SOFT_DOMAIN_SEARCHES[key] || [])) {
          allResults.push(...keywordSearch(allNodes, q, 20));
        }
        // Bare synonym searches (first 3 only — avoids fallback flooding from exotic synonyms)
        for (const syn of synList.slice(0, 3)) {
          allResults.push(...keywordSearch(allNodes, syn, 15));
        }
      } else {
        for (const syn of synList) {
          // Priority 1: combined frequency+exam signal (finds "1 exam/year" pages)
          allResults.push(...keywordSearch(allNodes, `${syn} frequency exam`, 20));
          // Priority 2: copayment / cost / services (main benefit table)
          allResults.push(...keywordSearch(allNodes, `${syn} copayment`, 25));
          allResults.push(...keywordSearch(allNodes, `${syn} cost`, 20));
          allResults.push(...keywordSearch(allNodes, `${syn} services`, 20));
          // Priority 3: individual frequency/exam (broader fallback)
          allResults.push(...keywordSearch(allNodes, `${syn} frequency`, 20));
          allResults.push(...keywordSearch(allNodes, `${syn} exam`, 20));
          // Priority 4: bare term (maximum recall)
          allResults.push(...keywordSearch(allNodes, syn, 15));
        }
      }

      // Title-based anchoring: benefit description sections for this term.
      // Appended after keyword results so they don't displace copay/frequency
      // pages from their priority slots, but still get included in the pool.
      const titleWords = [coreTerm, ...synList.map(s => s.split(' ')[0])]
        .filter(w => w.length >= 3);
      allNodes
        .filter(n => n.title && titleWords.some(t => n.title.toLowerCase().includes(t)))
        .forEach(n => allResults.push(n));

      const termSeen = new Set();
      let added = 0;
      for (const node of allResults) {
        if (!termSeen.has(node.nodeId) && added < pagesPerTerm) {
          termSeen.add(node.nodeId);
          finalNodes.push(node);
          added++;
        }
      }
    }

    return getNodeContents(allNodes, finalNodes.map(n => String(n.nodeId)));
  }

  // ── Single-benefit: original keyword + GPT selection path ────────────────
  //
  // WHY augment: "Podiatry" appears in both the benefits table (has "$0")
  // AND the appendix/index (just mentions the word).
  // Adding "copayment" to the search boosts cost-table pages over index pages.
  const augmentedQuery = queryType === 'benefit' ? `${searchQuery} copayment` : searchQuery;
  const keywordCandidates = keywordSearch(allNodes, searchQuery, 30);
  const augCandidates     = queryType === 'benefit' ? keywordSearch(allNodes, augmentedQuery, 15) : [];
  const anchorPages       = allNodes.slice(0, 25);

  // Title-based anchoring: find sections whose HEADING contains query keywords.
  // WHY: benefit description pages (allowance amount, vendor name, frequency,
  // how-to-access) live in named sections like "Supplemental Dental Benefits"
  // or "Routine Vision Services" — their body text differs from the benefits
  // chart so keyword search misses them, but their TITLES are reliable signals.
  // Example: "Supplemental Dental Benefits" has "$2,000 allowance • Cigna DPPO"
  // but the body text doesn't say "dental copayment" — keyword search skips it.
  const titleTerms = searchQuery.toLowerCase()
    .replace(/[*()[\]?/\\]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3);
  const titleMatches = allNodes.filter(n =>
    n.title && titleTerms.some(t => n.title.toLowerCase().includes(t))
  );

  const seen = new Set(), candidates = [];
  // Title matches inserted BEFORE anchorPages so GPT sees them near the top of the directory
  [...keywordCandidates, ...augCandidates, ...titleMatches, ...anchorPages].forEach(n => {
    if (!seen.has(n.nodeId)) { seen.add(n.nodeId); candidates.push(n); }
  });

  const nodeDirectory = buildNodeDirectory(candidates, 60);

  const selectionPrompt =
`You are a healthcare EOC (Evidence of Coverage) document navigator.
Select the ${nodeLimit} most relevant sections from "${stored.filename}" for the search query.

HOW TO SELECT — use SECTION TITLES and content signals, not page number ranges.
Page ranges vary widely across plan documents; section titles are consistent.

Read the "| Section title —" label in each directory entry to guide selection:

- Titled "[Benefit Name] Benefit/Benefits/Coverage/Services"
  e.g. "Supplemental Dental Benefits", "Routine Vision Services", "OTC Benefit"
  → ALWAYS include these: they contain allowance amount, vendor/network name,
    frequency limits, eligibility rules, and how to access the benefit.

- Titled "Benefits Chart", "Medical Benefits Chart", "What You Pay", "Your Costs"
  → contain copayments, coinsurance amounts, prior auth flags per service row.

- Titled "Service Area", "Plan Overview", "About Your Plan", "Eligibility"
  → contain counties covered, enrollment rules, member ID, contact numbers.

- Titled "Drug Coverage", "Formulary", "Prescription Drug", "Part D"
  → contain drug tiers, pharmacy network, formulary details.

SELECTION RULES:
1. BENEFIT DESCRIPTION (vendor, allowance, frequency, how-to-access):
   → prioritize sections whose TITLE contains the benefit name.
2. COST / COPAYMENT:
   → prioritize sections titled "Benefits Chart" / "What You Pay" or containing the service name.
3. ALWAYS include BOTH the benefit description section (title match) AND the
   benefits chart entry (keyword match) — they contain DIFFERENT information.
4. Cast a wide net — better to over-select than miss the answer.

Return ONLY a JSON array of section ID strings e.g. ["7","90","141"].

Search query: "${searchQuery}"

Section directory:
${nodeDirectory}`;

  let selectedIds = [];
  try {
    const resp = await getOpenAI().chat.completions.create({
      model: SELECT_MODEL, max_tokens: 150, temperature: 0,
      messages: [{ role: 'user', content: selectionPrompt }],
    });
    const parsed = JSON.parse(resp.choices[0].message.content.trim());
    if (Array.isArray(parsed)) selectedIds = parsed.map(String);
  } catch {
    selectedIds = candidates.slice(0, nodeLimit).map(n => String(n.nodeId));
  }

  const validIds = selectedIds.filter(id => allNodes.some(n => String(n.nodeId) === id));
  const gptPicks = validIds.length > 0
    ? validIds.slice(0, nodeLimit)
    : candidates.slice(0, nodeLimit).map(n => String(n.nodeId));

  // For benefit queries, hard-include top title-matched section pages.
  // WHY: GPT selection prefers benefits-chart pages (copay data) and may drop
  // named section pages like "OTC Wallet" or "Dental Benefit" that contain the
  // allowance amount, vendor name, and frequency limits the chart omits.
  // This is especially common for 3-char acronyms like OTC where the section
  // title ("OTC Wallet") uses terminology absent from the benefits chart.
  const guaranteedTitleIds = queryType === 'benefit'
    ? titleMatches.slice(0, 2).map(n => String(n.nodeId))
    : [];
  const guaranteedSet = new Set(guaranteedTitleIds);
  const finalIds = [
    ...guaranteedTitleIds,
    ...gptPicks.filter(id => !guaranteedSet.has(id)),
  ];

  return getNodeContents(allNodes, finalIds);
}



// ─── Main handler ─────────────────────────────────────────────────────────────

export async function POST(request) {
  try {
    const { message, docIds = [], history = [] } = await request.json();

    if (!message?.trim()) return Response.json({ error: 'Message required.' }, { status: 400 });
    if (!docIds.length)    return Response.json({ error: 'No documents loaded.' }, { status: 400 });

    // Ensure tree indices are in /tmp — fetches from Blob on cold starts where /tmp is empty
    await Promise.all(docIds.map(id => ensureTreeIndex(id)));

    // Load all indexed docs
    const allLoadedDocs = docIds
      .map(id => { const s = loadTreeIndex(id); return s ? { docId:id, filename:s.filename, stored:s } : null; })
      .filter(Boolean);
    if (allLoadedDocs.length === 0) return Response.json({ error: 'Documents not found. Reload the page.' }, { status: 404 });

    // ── PHASE 0: Detect conversational messages — skip retrieval ─────────────
    // Greetings, thanks, meta-questions about the app don't need doc retrieval.
    // Sending them through the full pipeline wastes tokens and may exceed limits.
    const CONVERSATIONAL = /^(hey|hi|hello|how are|thanks|thank you|who are you|what (can|do) you|help me|good (morning|afternoon|evening))/i;
    if (CONVERSATIONAL.test(message.trim()) && message.trim().length < 80) {
      const quickReply = await getOpenAI().chat.completions.create({
        model: SELECT_MODEL, max_tokens: 200, temperature: 0.7,
        messages: [
          { role: 'system', content: 'You are HealthworksAI, a healthcare benefits assistant. Respond briefly and helpfully. Mention you can answer questions about the loaded healthcare plan documents.' },
          { role: 'user',   content: message },
        ],
      });
      const reply = quickReply.choices[0].message.content;
      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        start(controller) {
          const fakeChunk = { choices: [{ delta: { content: reply }, finish_reason: 'stop' }] };
          controller.enqueue(encoder.encode('data: [SOURCES]' + JSON.stringify([]) + '\n\n'));
          controller.enqueue(encoder.encode('data: ' + JSON.stringify(fakeChunk) + '\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(readable, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
      });
    }

    // ── PHASE 0b: Detect pure reformatting follow-ups ────────────────────────
    // When user asks to change the FORMAT of the previous answer (table, chart, pie,
    // bar, line) while referencing "it / same / above / that", skip document retrieval
    // entirely and reformat the last assistant message directly.
    const REFORMAT_TYPE = /\b(tabular|table|pie\s*chart|piechart|bar\s*chart|barchart|line\s*chart|linechart|area\s*chart|donut|graph|chart|visuali[sz])\b/i;
    const REF_PREVIOUS  = /\b(it|same|above|that|those|the above|previous|prior)\b/i;
    const lastAssistantContent = history.filter(m => m.role === 'assistant').slice(-1)[0]?.content;

    if (REFORMAT_TYPE.test(message) && REF_PREVIOUS.test(message) && lastAssistantContent) {
      const VISUALIZATION_SCHEMA =
`VISUALISATION INSTRUCTIONS
When the user asks for a chart, table, graph, or visualization, embed [CHART]...[/CHART] blocks AFTER a brief explanation.

Choose "type" based on what was asked:
  "bar"   → side-by-side category comparison   "line"  → trends / sequences
  "area"  → line with filled area               "pie"   → part-of-whole breakdown
  "donut" → pie with hole                       "table" → rows and columns (use for "tabular format")

Bar / Line / Area:
[CHART]
{"type":"bar","title":"Title","subtitle":"Source","labels":["Plan A","Plan B"],"datasets":[{"label":"Metric","values":[0,10],"color":"#7C3AED"}],"yAxisLabel":"Value"}
[/CHART]
Pie / Donut:
[CHART]
{"type":"pie","title":"Title","subtitle":"Source","labels":["A","B"],"values":[60,40],"colors":["#7C3AED","#3B82F6"]}
[/CHART]
Table:
[CHART]
{"type":"table","title":"Title","subtitle":"Source","columns":["Plan","Service","Cost","Prior Auth"],"rows":[["Plan A","Service","$0","Yes"]],"highlight":[0]}
[/CHART]`;

      const reformatResp = await getOpenAI().chat.completions.create({
        model: ANSWER_MODEL, max_tokens: 2000, temperature: 0.1, stream: false,
        messages: [
          { role: 'system', content: `You are HealthworksAI, an expert healthcare benefits analyst. The user wants to reformat or visualize the previous answer. Extract all data from the previous answer and present it in the requested format.\n\n${VISUALIZATION_SCHEMA}` },
          { role: 'assistant', content: lastAssistantContent },
          { role: 'user', content: message },
        ],
      });

      const reformatAnswer = reformatResp.choices[0].message.content || '';
      const enc2 = new TextEncoder();
      const reformatStream = new ReadableStream({
        async start(ctrl) {
          ctrl.enqueue(enc2.encode(`data: [SOURCES]${JSON.stringify([])}\n\n`));
          const words = reformatAnswer.split(' ');
          for (let i = 0; i < words.length; i += 8) {
            const chunk = words.slice(i, i + 8).join(' ') + (i + 8 < words.length ? ' ' : '');
            ctrl.enqueue(enc2.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: chunk }, finish_reason: null }] }) + '\n\n'));
          }
          ctrl.enqueue(enc2.encode('data: [DONE]\n\n'));
          ctrl.close();
        },
      });
      return new Response(reformatStream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
      });
    }

    // ── PHASE 0: Analyze query ──────────────────────────────────────────────
    const { searchQuery, queryType, docTargets } = await analyzeQuery(message, history);
    // Extract individual benefit terms for multi-benefit queries
    // e.g. "[ Acupuncture Copay, Podiatry Copay, Emergency Care Copay ]" → 3 terms
    const benefitTerms = extractBenefitTerms(message);
    // Detect which of the 12 schema categories apply — drives per-category field
    // injection in the Phase 3 system prompt (only runs for benefit/general queries)
    const detectedCategories = (queryType === 'benefit' || queryType === 'general')
      ? detectBenefitCategories(message, '', benefitTerms)
      : [];

    // ── PHASE 1: Local pre-filtering (zero API calls) ───────────────────────
    let { docs: targetDocs, missingDocs } = filterRelevantDocs(allLoadedDocs, searchQuery, queryType, docTargets);

    // ── Fallback: GPT extracted a doc ID that isn't in the loaded library ────
    // This happens when the user refers to a plan by name (e.g. "Aetna Medicare
    // Value Plus") and GPT guesses a filename that doesn't match anything loaded.
    // Instead of erroring, fall back to keyword-scored selection across all
    // currently-loaded docs (which are already scoped by the UI filters).
    if (targetDocs.length === 0 && missingDocs.length > 0 && allLoadedDocs.length > 0) {
      ({ docs: targetDocs } = filterRelevantDocs(allLoadedDocs, searchQuery, queryType, []));
      missingDocs = [];
    }

    // ── Early exit: named docs not found in library ───────────────────────────
    if (missingDocs.length > 0 && targetDocs.length === 0) {
      const errMsg = `The following document(s) you mentioned are **not loaded** in the PDF library:\n\n` +
        missingDocs.map(d => `- ❌ **${d}**`).join('\n') +
        `\n\nDocuments currently loaded:\n` +
        allLoadedDocs.map(d => `- ✅ ${d.filename}`).join('\n') +
        `\n\nPlease check the filename and try again, or ask about one of the loaded documents.`;
      const encoder2 = new TextEncoder();
      const errChunk = { choices: [{ delta: { content: errMsg }, finish_reason: 'stop' }] };
      const errStream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(encoder2.encode('data: [SOURCES]' + JSON.stringify([]) + '\n\n'));
          ctrl.enqueue(encoder2.encode('data: ' + JSON.stringify(errChunk) + '\n\n'));
          ctrl.enqueue(encoder2.encode('data: [DONE]\n\n'));
          ctrl.close();
        },
      });
      return new Response(errStream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
      });
    }

    // Partial match — some named docs found, some missing — note the missing ones
    const missingNote = missingDocs.length > 0
      ? `\n\n> ⚠️ Note: ${missingDocs.join(', ')} was not found in the loaded library and was skipped.`
      : ''

    // ── PHASE 2: Retrieve nodes per doc (parallel) ──────────────────────────
    const docResults = await Promise.all(
      targetDocs.map(async doc => {
        let nodes;
        if (queryType === 'plan_info') {
          nodes = getIntroPagesForDoc(doc.stored);
        } else {
          nodes = await selectNodesForDoc(doc.stored, searchQuery, queryType, benefitTerms, targetDocs.length);
        }
        return { filename: doc.filename, nodes, stored: doc.stored };
      })
    );

    // ── Build context ────────────────────────────────────────────────────────
    const contextParts = [], sourcedFrom = [];
    for (const { filename, nodes } of docResults) {
      if (!nodes.length) continue;
      const snippets = extractSnippets(nodes, searchQuery, 300);
      contextParts.push(`${'═'.repeat(50)}\nDOCUMENT: ${filename}\n${'═'.repeat(50)}\n${snippets}`);
      nodes.forEach(n => sourcedFrom.push(`${filename} · ${n.title}${n.pages ? ` (pp.${n.pages})` : ''}`));
    }

    if (!contextParts.length) return Response.json({ error: 'No relevant content found.' }, { status: 404 });

    // Append missing doc warning to context so GPT-4o mentions it in the answer
    if (missingNote) contextParts.push(missingNote);

    // Per-doc budget: divide MAX_CONTEXT_CHARS equally so one large doc can't
    // crowd out another. Each doc gets an equal share; unused budget is not redistributed
    // (keeps it simple and prevents the first doc from eating everything).
    const perDocBudget = Math.floor(MAX_CONTEXT_CHARS / Math.max(contextParts.length, 1));
    const truncatedParts = contextParts.map(part =>
      part.length > perDocBudget
        ? part.slice(0, perDocBudget) + '\n[Doc context truncated to fit token budget]'
        : part
    );
    let context = truncatedParts.join('\n\n');

    // ── PHASE 3: Generate answer (with auto-retry if "not found") ────────────
    //
    // How auto-retry works:
    //   Pass 1: Use selected nodes → get answer
    //   If answer contains "not found" / "not mentioned" / "not available"
    //   → the selection step likely picked wrong pages
    //   Pass 2: Re-retrieve with DOUBLED node count + wider keyword search
    //           (uses a different random seed via temperature=0.3 on selection)
    //   → GPT-4o answers from the broader context
    //
    // This eliminates the need for the user to manually re-ask.

    // Catches all common GPT "not found" phrasings so the auto-retry fires:
    //   "not found in the provided context"
    //   "not provided in the excerpts above"
    //   "Not found."  (standalone — was missing)
    //   "does not provide specific information"  (was missing)
    //   "no information available"  (was missing)
    //   "cannot find / cannot provide information"  (was missing)
    const NOT_FOUND_PATTERN = new RegExp([
      // "not X in the provided/given/above/excerpts/context/..."
      'not (found|mentioned|available|provided|specified|included|present|contained|covered) in (the |these )?(provided|given|these|this|above|excerpts?|context|sections?|documents?|information)',
      // standalone "Not found" at start of sentence or label
      '\\bnot found\\b',
      // "does not provide/contain/include (specific/any) information/details"
      'does not (provide|contain|include|have) (specific |any )?(information|details?|data)',
      // "no (specific) information available/provided/found"
      'no (specific |relevant )?(information|data|details?) (is |are )?(available|provided|found)',
      // "cannot find/provide/locate information"
      'cannot (find|locate|provide|retrieve|access) (the |any |this |specific )?(information|details?|data|answer)',
      // "I (could not|was unable to) find information"
      'i (could not|was unable to|am unable to) (find|locate|identify|provide)',
    ].join('|'), 'i');

    const generateAnswer = async (ctx) => {
      const isMultiDoc   = targetDocs.length > 1;
      const docNamesList = targetDocs.map(d => d.filename).join(', ');
      const allDocNames  = allLoadedDocs.map(d => d.filename).join(', ');

      const systemPrompt =
`You are HealthworksAI, an expert healthcare benefits analyst.
Answer accurately based ONLY on the provided document sections.

${isMultiDoc ? `COMPARATIVE MODE — ${targetDocs.length} documents:
- Label each answer clearly: **H0976-001-000.pdf:** [answer] then **H0978-001-000.pdf:** [answer]
- If info differs between plans, highlight the difference
- End with a Comparison Summary
` : ''}
READING EOC BENEFITS CHARTS (2-column PDF table format):
EOC documents use a 2-column table: LEFT = "Covered Service" + description, RIGHT = "What you pay".
When extracted, the right-column cost value appears AFTER the left-column description text.

Rules for reading these tables:
1. The FIRST dollar amount ("$0", "$30", "$90") after a service name = that service's copayment.
2. Text that follows the dollar amount (e.g., "If you get emergency care at an out-of-network
   hospital...") describes EXCEPTIONS or CONDITIONS — it does NOT replace the primary copayment.
   Example: "Emergency care ... $0  If you get emergency care at an out-of-network hospital, your
   cost is..." → Emergency Care copayment = $0. Report "$0", not "cost not specified".
3. "$0" = "$0 copayment" = "no charge" = "covered at no cost to you". ALWAYS report the dollar
   amount you find — never say "cost not specified" if a $ value is present anywhere near the service.
4. Each section has [RELEVANT EXCERPTS] and [FULL PAGE TEXT] — scan BOTH before concluding not found.
5. Service name and its cost may be separated by a long description — keep reading past it.

TERMINOLOGY EQUIVALENCE — treat these as identical when answering:
- "Podiatry" = "Podiatry Services" = "Podiatry Care" = "Foot Care"
- "Acupuncture" = "Acupuncture Services" = "Acupuncture Care"
- "Emergency Care" = "Emergency Room" = "Emergency Services" = "ER Visit" = "Emergency Department"
- "Chiropractic" = "Chiropractic Services" = "Chiropractic Care" = "Spinal Manipulation"
- "copayment" = "copay" = "your cost" = "you pay" = "cost sharing" = "member cost" = "your share"
- "$0" = "no charge" = "no copayment" = "covered at no cost"
If a page says "Podiatry Services: You pay $0", that IS the copayment for Podiatry — report "$0".
Do NOT say "not found" if the information exists under a slightly different label or phrasing.

Always cite document name and page, e.g. "**H0976-001-000.pdf, Page 90**".
Only say "not found" after scanning EVERY excerpt AND full text section provided.

──────────────────────────────────────────────────────────────────
VISUALISATION INSTRUCTIONS
──────────────────────────────────────────────────────────────────
When the user asks for a chart, table, graph, visualization, or comparison in visual form,
embed one or more [CHART]...[/CHART] blocks AFTER your text explanation.

Choose "type" based on what was asked:
  "bar"     → side-by-side category comparison (default for cost comparisons)
  "stacked" → stacked bar (e.g. "stacked bar chart")
  "line"    → trends over time / sequences
  "area"    → line with filled area
  "pie"     → part-of-whole breakdown
  "donut"   → pie with hole (e.g. "donut chart")
  "scatter" → x/y correlation
  "table"   → rows and columns of data (use for "tabular format", "table", "list as table")

SCHEMAS:
Bar / Stacked / Line / Area:
[CHART]
{"type":"bar","title":"Title","subtitle":"Source: Page N","labels":["Plan A","Plan B"],"datasets":[{"label":"Cost","values":[0,10],"color":"#7C3AED"}],"yAxisLabel":"Cost ($)"}
[/CHART]
Pie / Donut:
[CHART]
{"type":"pie","title":"Title","subtitle":"Source: Page N","labels":["Category A","Category B"],"values":[60,40],"colors":["#7C3AED","#3B82F6"]}
[/CHART]
Table:
[CHART]
{"type":"table","title":"Title","subtitle":"Source: Pages N","columns":["Plan","Service","Cost","Prior Auth"],"rows":[["SCAN Connections","Podiatry","$0","Yes"],["SCAN Classic","Podiatry","$0","Yes"]],"highlight":[0]}
[/CHART]
RULES:
- Match "type" exactly to what user asks
- Always write a brief text explanation BEFORE the [CHART] block
──────────────────────────────────────────────────────────────────
GENERAL EOC DATA EXTRACTION GUIDE
──────────────────────────────────────────────────────────────────
For ANY benefit query, scan ALL provided sections for every applicable
dimension below. Report each dimension explicitly — never skip one because
it seems minor or unlikely to be documented.
Distinguish: not stated = "Not specified" | not covered = "Not covered" | present but ambiguous = quote the text.

COVERAGE & ELIGIBILITY
  • Covered language / benefit description
  • Eligibility criteria (who qualifies, required conditions)
  • General conditions / how to access the benefit
  • Authorization / prior approval requirements

COST & FINANCIALS
  • Copay / coinsurance / cost share
  • Allowance amount / benefit value ($)
  • Financial caps (annual max, visit cap, combined limit)
  • Cost-share variations (by service type, modality, or tier)

LIMITS & UTILIZATION
  • Visit or usage limits (per year, per episode)
  • Quantity limits (number of items, rides, meals, etc.)
  • Time-based limits (service window, duration, per-period resets)
  • Carryover rules (does unused balance or visits roll over?)

SERVICES & OFFERINGS
  • Covered services / service types included
  • Eligible items / products (OTC items, food types, devices)
  • Modalities / delivery types (in-person, virtual, home delivery)
  • Included components (devices, meals, kits, starter packs)

ACCESS & LOGISTICS
  • Access channels (clinic, online portal, phone, retail, delivery)
  • Scheduling & cancellation rules
  • Geographic limitations (county, state, radius)
  • Purchase / redemption methods (barcode, card swipe, catalog)

VENDOR / PROGRAM INFO
  • Vendor / provider / network name
  • Platform or program name (e.g., "SilverSneakers", "NationsMarket")

FUNDING MECHANISM
  • Card / wallet name (member-facing label)
  • Wallet type / structure (prepaid card, digital credit, barcode)
  • Funding method (prepaid load, direct reimbursement, voucher)

EXCLUSIONS & RESTRICTIONS
  • Exclusions language (what is explicitly NOT covered)
  • Non-covered items / services
  • Special limitations or exceptions (e.g., observation stay not eligible, OON penalty)

ADDITIONAL FEATURES
  • Supplemental perks (credits, starter kits, bonus add-ons)
  • Benefit-specific features (e.g., rideshare option, modality tiers, trial period)
──────────────────────────────────────────────────────────────────
${getCategoryInstructions(detectedCategories)}
Documents provided for this query: ${docNamesList}
All documents loaded in system: ${allDocNames}
Query type detected: ${queryType}`;

      const conversationHistory = history
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-8)
        .map(m => ({ role: m.role, content: m.content }));

      // Non-streaming call for pass 1 — we need to check the answer before streaming
      const resp = await getOpenAI().chat.completions.create({
        model: ANSWER_MODEL, max_tokens: 3000, temperature: 0.2, stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          ...conversationHistory,
          { role: 'user',   content: `Document sections:\n\n${ctx}\n\nQuestion: ${message}` },
        ],
      });
      return resp.choices[0].message.content || '';
    };

    // ── Pass 1 ────────────────────────────────────────────────────────────────
    let finalAnswer = await generateAnswer(context);

    // ── Auto-retry if answer says "not found" ─────────────────────────────────
    if (NOT_FOUND_PATTERN.test(finalAnswer)) {
      // Re-retrieve with doubled node count and wider keyword search
      const retryNodeLimit = benefitTerms.length > 1
        ? Math.min(benefitTerms.length * 4, 16)
        : Math.min(MAX_NODES_PER_DOC * 2, 12);

      const widerDocResults = await Promise.all(
        targetDocs.map(async doc => {
          const allNodes = flattenAllNodes(doc.stored.structure).filter(n => n.text && n.text.length > 50);

          if (benefitTerms.length > 1) {
            // Multi-benefit retry: same frequency-first single-list approach, 8 pages/term
            const retryNodes = [];
            for (const term of benefitTerms) {
              const key = term.toLowerCase().replace(/\s+/g, ' ').trim();
              const coreTerm = key
                .replace(/\s*(copay|copayment)\s*$/i, '')
                .replace(/\bservices?\b/gi, '')
                .replace(/\s+/g, ' ')
                .trim();
              const synList = BENEFIT_SYNONYMS[key] || BENEFIT_SYNONYMS[coreTerm] || [coreTerm];
              const allR = [];
              for (const syn of synList) {
                allR.push(...keywordSearch(allNodes, `${syn} frequency exam`, 25));
                allR.push(...keywordSearch(allNodes, `${syn} copayment`, 40));
                allR.push(...keywordSearch(allNodes, `${syn} cost`, 30));
                allR.push(...keywordSearch(allNodes, `${syn} services`, 25));
                allR.push(...keywordSearch(allNodes, `${syn} frequency`, 25));
                allR.push(...keywordSearch(allNodes, `${syn} exam`, 25));
                allR.push(...keywordSearch(allNodes, syn, 20));
              }
              const termSeen = new Set();
              let added = 0;
              for (const node of allR) {
                if (!termSeen.has(node.nodeId) && added < 8) {
                  termSeen.add(node.nodeId); retryNodes.push(node); added++;
                }
              }
            }
            return { filename: doc.filename, nodes: getNodeContents(allNodes, retryNodes.map(n => String(n.nodeId))) };
          }

          // Single-benefit retry: wider keyword search + title anchoring + GPT selection
          const seenR = new Set(), wider = [];
          keywordSearch(allNodes, searchQuery, 50).forEach(n => {
            if (!seenR.has(n.nodeId)) { seenR.add(n.nodeId); wider.push(n); }
          });
          if (queryType === 'benefit') {
            keywordSearch(allNodes, `${searchQuery} copayment`, 20).forEach(n => {
              if (!seenR.has(n.nodeId)) { seenR.add(n.nodeId); wider.push(n); }
            });
          }
          // Title anchoring in retry — catches benefit description pages
          // (allowance, vendor, frequency) missed by the first pass
          const retryTitleTerms = searchQuery.toLowerCase()
            .replace(/[*()[\]?/\\]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 3);
          allNodes
            .filter(n => n.title && retryTitleTerms.some(t => n.title.toLowerCase().includes(t)))
            .forEach(n => {
              if (!seenR.has(n.nodeId)) { seenR.add(n.nodeId); wider.push(n); }
            });
          allNodes.slice(0, 30).forEach(n => {
            if (!seenR.has(n.nodeId)) { seenR.add(n.nodeId); wider.push(n); }
          });

          const dir = buildNodeDirectory(wider, 70);
          const selPrompt =
`You are a healthcare EOC document navigator — RETRY ATTEMPT.
The previous retrieval did NOT find the answer. You must look more broadly.

HOW TO SELECT — use SECTION TITLES, not page number ranges (structure varies per plan).

- Sections titled "[Benefit Name] Benefit/Benefits/Coverage"
  → contain allowance amount, vendor/network, frequency, how-to-access.
- Sections titled "Benefits Chart" / "What You Pay" / "Your Costs"
  → contain copayments and coinsurance per service row.
- Sections titled "Service Area" / "Eligibility" / "Plan Overview"
  → contain counties, enrollment rules, contact info.

For query "${searchQuery}", the answer MUST exist in this document.
Select the ${retryNodeLimit} most likely sections.
Prioritize sections whose TITLE matches the benefit name AND benefit chart sections.
Cast the widest possible net. Return ONLY a JSON array of section IDs.

Section directory:
${dir}`;

          let retryIds = [];
          try {
            const r = await getOpenAI().chat.completions.create({
              model: SELECT_MODEL, max_tokens: 200, temperature: 0.4,
              messages: [{ role: 'user', content: selPrompt }],
            });
            const parsed = JSON.parse(r.choices[0].message.content.trim());
            if (Array.isArray(parsed)) retryIds = parsed.map(String);
          } catch {
            retryIds = wider.slice(0, retryNodeLimit).map(n => String(n.nodeId));
          }

          const validRetry = retryIds.filter(id => allNodes.some(n => String(n.nodeId) === id));
          const finalRetry = validRetry.length > 0 ? validRetry : wider.slice(0, retryNodeLimit).map(n => String(n.nodeId));
          return { filename: doc.filename, nodes: getNodeContents(allNodes, finalRetry) };
        })
      );

      // Rebuild context with wider retrieval
      const retryParts = [], retrySources = [];
      for (const { filename, nodes } of widerDocResults) {
        if (!nodes.length) continue;
        const snippets = extractSnippets(nodes, searchQuery, 400); // wider snippets
        retryParts.push(`${'═'.repeat(50)}\nDOCUMENT: ${filename} [EXPANDED SEARCH]\n${'═'.repeat(50)}\n${snippets}`);
        nodes.forEach(n => retrySources.push(`${filename} · ${n.title}${n.pages ? ` (pp.${n.pages})` : ''}`));
      }

      if (retryParts.length) {
        let retryContext = retryParts.join('\n\n');
        if (retryContext.length > MAX_CONTEXT_CHARS) retryContext = retryContext.slice(0, MAX_CONTEXT_CHARS);
        const retryAnswer = await generateAnswer(retryContext);
        // Use retry answer only if it's better (doesn't contain "not found")
        if (!NOT_FOUND_PATTERN.test(retryAnswer) || retryAnswer.length > finalAnswer.length) {
          finalAnswer = retryAnswer;
          sourcedFrom.length = 0;
          retrySources.forEach(s => sourcedFrom.push(s));
        }
      }
    }

    // ── Stream the final answer ───────────────────────────────────────────────
    const encoder  = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: [SOURCES]${JSON.stringify(sourcedFrom)}\n\n`));
        // Stream the answer word-by-word for smooth UX
        const words = finalAnswer.split(' ');
        for (let i = 0; i < words.length; i += 8) {
          const chunk = words.slice(i, i + 8).join(' ') + (i + 8 < words.length ? ' ' : '');
          const fakeChunk = { choices: [{ delta: { content: chunk }, finish_reason: null }] };
          controller.enqueue(encoder.encode('data: ' + JSON.stringify(fakeChunk) + '\n\n'));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    return new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });

  } catch (err) {
    console.error('[chat] error:', err);
    return Response.json({ error: err.message || 'Internal error.' }, { status: 500 });
  }
}
