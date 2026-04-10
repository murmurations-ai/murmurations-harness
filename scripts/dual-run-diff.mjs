#!/usr/bin/env node
/**
 * Phase 2 step 2D6 — structured dual-run diff tool.
 *
 * Consumes two Research Agent digest files — one from the harness
 * (with the 2D5 YAML provenance header) and one from the parallel
 * OpenClaw runner (plain markdown) — and emits a JSON report
 * scoring the two against each other on four axes:
 *
 *   1. Item-set diff — bullet items on each side are normalized,
 *      the two sets are compared, Jaccard similarity is computed,
 *      `drift = 1 - similarity`. Phase 2 gate: drift ≤ 0.10.
 *   2. Normalized-text similarity — bag-of-words Jaccard over the
 *      full body after normalization (lowercase, collapse
 *      whitespace, strip markdown syntax tokens).
 *   3. Cost delta — harness cost comes from the YAML header
 *      (`llm_cost_usd` field) which the run-artifact writer
 *      populates from the WakeCostRecord. OpenClaw's digest body
 *      does not carry cost, so the operator passes it via
 *      `--openclaw-cost-micros N` or `--openclaw-cost-usd X.Y`.
 *      Phase 2 gate: |harness - openclaw| / openclaw ≤ 0.10.
 *   4. Wall-clock delta — same shape; harness from YAML header
 *      (computed from started_at and finished_at), OpenClaw via
 *      `--openclaw-wall-clock-ms N`.
 *
 * Usage:
 *
 *   node scripts/dual-run-diff.mjs <harness-digest> <openclaw-digest> [options]
 *
 * Options:
 *   --openclaw-cost-micros N     OpenClaw cost in USD micros (integer)
 *   --openclaw-cost-usd X.Y      OpenClaw cost in USD (float; converted to micros)
 *   --openclaw-wall-clock-ms N   OpenClaw wall-clock duration in ms
 *   --thresholds                 Include a PASS/FAIL block evaluated
 *                                against the Phase 2 gate criteria
 *
 * Exit codes:
 *   0 — diff produced successfully (with or without threshold failures)
 *   1 — input file unreadable or missing
 *   2 — argument parsing failure
 *   3 — threshold failure (only when --thresholds is set)
 *
 * Zero runtime dependencies beyond Node built-ins. This script is
 * intentionally standalone so it can run in any CI environment
 * without requiring the monorepo to be built.
 */

import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

const usage = () => `
dual-run-diff — Phase 2 Research Agent dual-run diff (2D6)

Usage:
  node scripts/dual-run-diff.mjs <harness-digest> <openclaw-digest> [options]

Options:
  --openclaw-cost-micros N     OpenClaw cost in USD micros (integer)
  --openclaw-cost-usd X.Y      OpenClaw cost in USD (float; converted)
  --openclaw-wall-clock-ms N   OpenClaw wall-clock duration in ms
  --thresholds                 Add PASS/FAIL block vs Phase 2 gates

Thresholds (when --thresholds is set):
  item-set drift ≤ 10%   (1 - jaccardSimilarity of bullet items)
  cost delta ≤ 10%       (abs(harness - openclaw) / openclaw)
`;

const parseArgs = (argv) => {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--openclaw-cost-micros") {
      const v = argv[i + 1];
      if (!v) throw new Error("--openclaw-cost-micros requires a value");
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        throw new Error(`--openclaw-cost-micros must be a non-negative integer; got ${v}`);
      }
      options.openclawCostMicros = n;
      i++;
    } else if (a === "--openclaw-cost-usd") {
      const v = argv[i + 1];
      if (!v) throw new Error("--openclaw-cost-usd requires a value");
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`--openclaw-cost-usd must be a non-negative number; got ${v}`);
      }
      options.openclawCostMicros = Math.round(n * 1_000_000);
      i++;
    } else if (a === "--openclaw-wall-clock-ms") {
      const v = argv[i + 1];
      if (!v) throw new Error("--openclaw-wall-clock-ms requires a value");
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        throw new Error(`--openclaw-wall-clock-ms must be a non-negative integer; got ${v}`);
      }
      options.openclawWallClockMs = n;
      i++;
    } else if (a === "--thresholds") {
      options.thresholds = true;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else if (a.startsWith("--")) {
      throw new Error(`unknown option: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) {
    throw new Error(`expected 2 positional args (harness, openclaw); got ${positional.length}`);
  }
  return { harnessPath: positional[0], openclawPath: positional[1], options };
};

// ---------------------------------------------------------------------------
// Digest parsing
// ---------------------------------------------------------------------------

/**
 * Split a markdown document into `{ header, body }` where `header`
 * is a key→string map parsed from the YAML frontmatter (if present)
 * and `body` is everything after the closing `---`. If there is no
 * frontmatter, `header` is null and `body` is the whole file.
 *
 * The header parser is deliberately minimal — it handles
 * `key: value` lines and nothing else (no nested objects, no lists,
 * no block scalars). The harness digest header only uses flat
 * key/value pairs so this is sufficient, and it keeps the script
 * dependency-free.
 */
const splitDigest = (text) => {
  const fence = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = fence.exec(text);
  if (!match) return { header: null, body: text };
  const [, yaml, rest] = match;
  const header = {};
  for (const line of yaml.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (kv) {
      const [, key, value] = kv;
      header[key] = value.trim();
    }
  }
  return { header, body: rest };
};

/** Extract cost, wall-clock, and provider info from the harness YAML
 *  header. Returns `null` for any field the header doesn't carry. */
const extractHarnessProvenance = (header) => {
  if (!header) {
    return {
      wakeId: null,
      agentId: null,
      outcome: null,
      provider: null,
      model: null,
      costMicros: null,
      wallClockMs: null,
    };
  }
  const parseIsoMs = (s) => {
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  };
  const started = parseIsoMs(header.started_at);
  const finished = parseIsoMs(header.finished_at);
  const wallClockMs = started !== null && finished !== null ? finished - started : null;
  const costUsd = header.llm_cost_usd ? Number(header.llm_cost_usd) : null;
  const costMicros =
    costUsd !== null && Number.isFinite(costUsd) ? Math.round(costUsd * 1_000_000) : null;
  return {
    wakeId: header.wake_id ?? null,
    agentId: header.agent_id ?? null,
    outcome: header.outcome ?? null,
    provider: header.llm_provider ?? null,
    model: header.llm_model ?? null,
    costMicros,
    wallClockMs,
  };
};

// ---------------------------------------------------------------------------
// Text + item extraction
// ---------------------------------------------------------------------------

/**
 * Normalize a string for similarity comparison: lowercase, strip
 * common markdown tokens (`*`, `_`, `` ` ``, `#`, `>`, brackets),
 * collapse whitespace. Preserves alphanumeric and hyphens so phrases
 * like `multi-agent` survive intact.
 */
const normalizeText = (s) =>
  s
    .toLowerCase()
    .replace(/[*_`#>]/g, " ")
    .replace(/[\[\]()]/g, " ")
    .replace(/[^a-z0-9\- ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Extract the bullet items from a markdown body. A "bullet" is any
 * line starting with `- `, `* `, or `+ ` (possibly indented). The
 * bullet content is sliced at the first `—` (em-dash) or ` - `
 * (hyphen surrounded by spaces) so trailing descriptors like
 * `— confidence: low` or `— implication for EP` that vary between
 * runners are dropped before normalization. What remains is the
 * "item identity" — the topic name Jaccard compares against.
 */
const extractItems = (body) => {
  const items = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const m = /^\s*[-*+]\s+(.+)$/.exec(rawLine);
    if (!m) continue;
    // Split BEFORE normalizing so the em-dash is still present to
    // split on — normalizeText turns `—` into whitespace.
    const head = m[1].split(/\s[—–-]\s/)[0];
    const normalized = normalizeText(head);
    if (normalized.length > 0) items.push(normalized);
  }
  return items;
};

/** Jaccard similarity of two string sets. */
const jaccard = (a, b) => {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
};

/** Bag-of-words Jaccard over the full body — not a rigorous
 *  similarity measure, but cheap and directionally correct for the
 *  diff tool's purpose. */
const textSimilarity = (bodyA, bodyB) => {
  const tokenize = (s) => normalizeText(s).split(" ").filter((t) => t.length > 2);
  return jaccard(tokenize(bodyA), tokenize(bodyB));
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async () => {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    process.stderr.write(`dual-run-diff: ${err.message}\n`);
    process.stderr.write(usage());
    process.exit(2);
  }
  const { harnessPath, openclawPath, options } = parsed;

  let harnessText, openclawText;
  try {
    harnessText = await readFile(resolve(harnessPath), "utf8");
  } catch (err) {
    process.stderr.write(`dual-run-diff: failed to read harness digest: ${err.message}\n`);
    process.exit(1);
  }
  try {
    openclawText = await readFile(resolve(openclawPath), "utf8");
  } catch (err) {
    process.stderr.write(`dual-run-diff: failed to read openclaw digest: ${err.message}\n`);
    process.exit(1);
  }

  const harness = splitDigest(harnessText);
  const openclaw = splitDigest(openclawText);
  const provenance = extractHarnessProvenance(harness.header);

  const harnessItems = extractItems(harness.body);
  const openclawItems = extractItems(openclaw.body);

  const similarity = jaccard(harnessItems, openclawItems);
  const drift = 1 - similarity;
  const onlyInHarness = harnessItems.filter((i) => !openclawItems.includes(i));
  const onlyInOpenclaw = openclawItems.filter((i) => !harnessItems.includes(i));
  const inBoth = harnessItems.filter((i) => openclawItems.includes(i));

  const textSim = textSimilarity(harness.body, openclaw.body);

  // Cost delta (harness from YAML; openclaw from flags)
  const harnessCost = provenance.costMicros;
  const openclawCost = options.openclawCostMicros ?? null;
  const costDelta =
    harnessCost !== null && openclawCost !== null ? harnessCost - openclawCost : null;
  const costDeltaRelative =
    costDelta !== null && openclawCost !== null && openclawCost > 0
      ? Math.abs(costDelta) / openclawCost
      : null;

  // Wall-clock delta
  const harnessWallClockMs = provenance.wallClockMs;
  const openclawWallClockMs = options.openclawWallClockMs ?? null;
  const wallClockDelta =
    harnessWallClockMs !== null && openclawWallClockMs !== null
      ? harnessWallClockMs - openclawWallClockMs
      : null;
  const wallClockDeltaRelative =
    wallClockDelta !== null && openclawWallClockMs !== null && openclawWallClockMs > 0
      ? Math.abs(wallClockDelta) / openclawWallClockMs
      : null;

  const report = {
    schemaVersion: 1,
    inputs: {
      harnessPath: basename(harnessPath),
      openclawPath: basename(openclawPath),
    },
    harness: {
      wakeId: provenance.wakeId,
      agentId: provenance.agentId,
      outcome: provenance.outcome,
      llmProvider: provenance.provider,
      llmModel: provenance.model,
      llmCostMicros: harnessCost,
      wallClockMs: harnessWallClockMs,
    },
    openclaw: {
      llmCostMicros: openclawCost,
      wallClockMs: openclawWallClockMs,
    },
    items: {
      harnessCount: harnessItems.length,
      openclawCount: openclawItems.length,
      inBothCount: inBoth.length,
      onlyInHarness,
      onlyInOpenclaw,
      jaccardSimilarity: Number(similarity.toFixed(4)),
      drift: Number(drift.toFixed(4)),
    },
    text: {
      jaccardSimilarity: Number(textSim.toFixed(4)),
    },
    cost: {
      deltaMicros: costDelta,
      deltaRelative: costDeltaRelative !== null ? Number(costDeltaRelative.toFixed(4)) : null,
    },
    wallClock: {
      deltaMs: wallClockDelta,
      deltaRelative:
        wallClockDeltaRelative !== null ? Number(wallClockDeltaRelative.toFixed(4)) : null,
    },
  };

  if (options.thresholds) {
    const DRIFT_CEILING = 0.10;
    const COST_CEILING = 0.10;
    const driftPass = drift <= DRIFT_CEILING;
    const costPass =
      costDeltaRelative === null ? null : costDeltaRelative <= COST_CEILING;
    const overallPass = driftPass && (costPass === null ? true : costPass);
    report.thresholds = {
      driftCeiling: DRIFT_CEILING,
      costCeiling: COST_CEILING,
      driftPass,
      costPass,
      overallPass,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(overallPass ? 0 : 3);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
};

main().catch((err) => {
  process.stderr.write(`dual-run-diff: fatal: ${err.message}\n`);
  process.exit(1);
});
