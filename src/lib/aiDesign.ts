// Turn a developer's prompt into a design with an LLM, and turn the LLM's JSON back into a
// validated Design. Pure functions: used by the /api/generate route and the playground UI.

import type { Config, ConfigValue, Design, DesignNode, Problem } from './types';
import { SERVICE_MAP } from './catalog';
import { B, R } from './problems/make';
import { describeSchema, isDbService, sanitizeSchema } from './schema';

export interface AiResult {
  design: Design;
  summary: string;
  rationale: string;
  warnings: string[];
  /** Present when the model was asked to estimate the workload itself. */
  workload: Workload | null;
}

/** The scenario a free-form design is sized and scored against. */
export interface Workload {
  peakQps: number;
  /** 0..1 */
  readRatio: number;
  storageGB: number;
  payloadKB: number;
  /** p95 target in ms */
  latencyMs: number;
  /** USD per month */
  budgetUSD: number;
  /** share of traffic cacheable at the CDN, 0..1 */
  cdnFriendly: number;
  /** share of reads cacheable in memory, 0..1 */
  cacheable: number;
}

export const DEFAULT_WORKLOAD: Workload = {
  peakQps: 1000,
  readRatio: 0.8,
  storageGB: 100,
  payloadKB: 5,
  latencyMs: 300,
  budgetUSD: 2000,
  cdnFriendly: 0,
  cacheable: 0.5,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function normalizeWorkload(raw: unknown, base: Workload = DEFAULT_WORKLOAD): Workload {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const num = (k: keyof Workload, lo: number, hi: number) => {
    const n = Number(r[k]);
    return Number.isFinite(n) ? clamp(n, lo, hi) : base[k];
  };
  return {
    peakQps: num('peakQps', 1, 5_000_000),
    readRatio: num('readRatio', 0, 1),
    storageGB: num('storageGB', 0.1, 5_000_000),
    payloadKB: num('payloadKB', 0.1, 50_000),
    latencyMs: num('latencyMs', 5, 5000),
    budgetUSD: num('budgetUSD', 10, 10_000_000),
    cdnFriendly: num('cdnFriendly', 0, 1),
    cacheable: num('cacheable', 0, 1),
  };
}

/** A synthetic problem so any free-form design can be sized, costed and scored with the same engine. */
export function customProblem(w: Workload, prompt = ''): Problem {
  const title = prompt.trim() ? prompt.trim().split(/[.\n]/)[0].slice(0, 60) : 'Custom system';
  return {
    id: 'custom',
    title,
    tier: 'mid',
    tagline: prompt.trim().slice(0, 140) || 'Free-form design',
    tags: [],
    functional: [prompt.trim() || 'Free-form design'],
    nonFunctional: [`p95 latency under ${w.latencyMs} ms`, 'Stay within the monthly budget'],
    scale: {
      audience: 'Your workload',
      avgQps: Math.max(1, Math.round(w.peakQps * 0.4)),
      peakQps: w.peakQps,
      readRatio: w.readRatio,
      storageGB: w.storageGB,
      storageIn: 'db',
      payloadKB: w.payloadKB,
      cdnFriendly: w.cdnFriendly,
      cacheable: w.cacheable,
      cacheFirst: false,
      latencyMs: w.latencyMs,
      availability: '99.9%',
      budgetUSD: w.budgetUSD,
      note: 'Custom workload: numbers come from you (or the AI estimate).',
    },
    rubric: [
      R('db-read-capacity'),
      R('db-write-capacity'),
      R('storage-capacity'),
      R('latency-budget'),
      R('ha-db'),
      w.cacheable >= 0.4 ? R('cache-read') : B('cache-read'),
      w.cdnFriendly >= 0.4 ? R('cdn') : B('cdn'),
      B('waf'),
      B('auth'),
    ],
    pitfalls: [],
    hints: [],
  };
}

/** Compact, token-friendly description of every service the model may use. */
export function catalogGuide(): string {
  const lines: string[] = [];
  for (const def of Object.values(SERVICE_MAP)) {
    const fields = def.fields
      .map((f) => {
        if (f.type === 'select') return `${f.key}:${(f.options ?? []).map((o) => o.value).join('|')} (default ${String(f.default)})`;
        if (f.type === 'toggle') return `${f.key}:true|false (default ${String(f.default)})`;
        return `${f.key}:${f.min ?? ''}..${f.max ?? ''}${f.unit ? ' ' + f.unit : ''} (default ${String(f.default)})`;
      })
      .join('; ');
    lines.push(`- ${def.id} [${def.provides.join(',')}]${fields ? ` config { ${fields} }` : ''}`);
  }
  return lines.join('\n');
}

function describeWorkload(w: Workload): string {
  return (
    `Peak ${w.peakQps} req/s; ${Math.round(w.readRatio * 100)}% reads; ${w.storageGB} GB of data; responses ~${w.payloadKB} KB; ` +
    `${Math.round(w.cdnFriendly * 100)}% cacheable at the edge; ${Math.round(w.cacheable * 100)}% of reads cacheable in memory; ` +
    `p95 latency target ${w.latencyMs} ms; monthly budget about $${w.budgetUSD}.`
  );
}

export function describeDesign(d: Design): string {
  const nodes = d.nodes.map((n) => `${n.id}: ${n.serviceId}${n.label ? ` "${n.label}"` : ''} ${JSON.stringify(n.config)}${n.schema?.length ? ` data model: ${describeSchema(n.schema)}` : ''}`);
  const edges = d.edges.map((e) => `${e.source} -> ${e.target}`);
  return `Nodes:\n${nodes.join('\n')}\nEdges:\n${edges.join('\n')}`;
}

const WORKLOAD_SHAPE = `"workload":{"peakQps":0,"readRatio":0.8,"storageGB":0,"payloadKB":0,"latencyMs":0,"budgetUSD":0,"cdnFriendly":0,"cacheable":0}`;

const WORKLOAD_RULE =
  '\n- "workload" is your realistic estimate for the system described: peakQps (req/s at peak), readRatio (0-1), storageGB, payloadKB (average response), latencyMs (sensible p95 target), budgetUSD (sensible monthly budget), cdnFriendly (0-1 share of traffic cacheable at a CDN), cacheable (0-1 share of reads an in-memory cache could serve). Size the design for this workload.';

export function buildPrompts(args: {
  prompt: string;
  workload: Workload;
  /** Ask the model to estimate the workload itself instead of using `workload`. */
  estimate: boolean;
  base?: Design;
  feedback?: string[];
}): { system: string; user: string } {
  const system = `You are a principal cloud architect who designs any kind of system on Google Cloud for a learning platform.
You design by choosing services from the catalog below, configuring them, and connecting them.

CATALOG (id [capabilities] config { key:allowed values }):
${catalogGuide()}

RULES
- Use ONLY service ids from the catalog. Use only the config keys listed for that service, within the allowed ranges. Omit config to accept defaults.
- Exactly one "client" node is the entry point. Draw edges in the direction of the request: client -> (cdn/waf/apigw/lb) -> compute -> (cache / database / queue / storage).
- Anything asynchronous (queues, streams, workers, analytics) hangs off compute. A worker is a compute node connected to the queue it consumes.
- A cache only helps if it is connected to the compute that reads it. A database that nothing connects to does nothing.
- Size services for the PEAK load, with about 30% headroom, but do not wildly over-provision: cost matters and is scored against the budget.
- For database and cache nodes, include a "schema" list describing what each stores: [{"name":"users","fields":[{"name":"id","type":"uuid","key":"pk"}],"note":"access pattern"}]. key is one of "pk" (primary/partition/row key), "sk", "idx", "uq" or "". Choose keys that suit the store (for example a row key that does not lead with a timestamp in Bigtable, a non-sequential primary key in Spanner) and respect any data model already on the current design.
- Prefer the simplest design that meets the requirements. Add multi-region, streaming, etc. only when the request needs them.
- Reply with ONE JSON object and nothing else (no markdown fences), exactly in this shape:
{"summary":"one sentence","rationale":"3-6 short sentences on the key trade-offs and why each major service was chosen","nodes":[{"id":"n1","service":"<catalog id>","label":"optional short name","config":{}}],"edges":[["n1","n2"]]${args.estimate ? `,${WORKLOAD_SHAPE}` : ''}}${args.estimate ? WORKLOAD_RULE : ''}`;

  const parts: string[] = [];
  parts.push(
    args.estimate
      ? 'WORKLOAD: not specified. Estimate it from the description below.'
      : `WORKLOAD (size the design for this):\n${describeWorkload(args.workload)}`,
  );
  if (args.base && args.base.nodes.length) {
    parts.push(`CURRENT DESIGN (modify it rather than starting over unless asked):\n${describeDesign(args.base)}`);
    if (args.feedback?.length) parts.push(`ISSUES THE SCORER FOUND IN THE CURRENT DESIGN:\n- ${args.feedback.join('\n- ')}`);
  }
  parts.push(`WHAT THE DEVELOPER WANTS DESIGNED OR CHANGED:\n${args.prompt.trim()}`);
  return { system, user: parts.join('\n\n') };
}

function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function cleanConfig(serviceId: string, raw: unknown, warnings: string[]): Config {
  const def = SERVICE_MAP[serviceId];
  const out: Config = {};
  if (!def || !isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const f = def.fields.find((x) => x.key === k);
    if (!f) {
      warnings.push(`${serviceId}: ignored unknown setting "${k}".`);
      continue;
    }
    if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      let c = n;
      if (f.min !== undefined) c = Math.max(f.min, c);
      if (f.max !== undefined) c = Math.min(f.max, c);
      if (c !== n) warnings.push(`${serviceId}.${k}: ${n} clamped to ${c}.`);
      out[k] = c as ConfigValue;
    } else if (f.type === 'toggle') {
      out[k] = (v === true || v === 'true') as ConfigValue;
    } else if (f.type === 'select') {
      const val = String(v);
      if ((f.options ?? []).some((o) => o.value === val)) out[k] = val as ConfigValue;
      else warnings.push(`${serviceId}.${k}: "${val}" is not an option, used the default.`);
    }
  }
  return out;
}

/** Left-to-right layers from the client, so a generated design lands readable on the canvas. */
export function autoLayout(d: Design): Design {
  const adj = new Map<string, string[]>();
  for (const n of d.nodes) adj.set(n.id, []);
  for (const e of d.edges) {
    adj.get(e.source)?.push(e.target);
    adj.get(e.target)?.push(e.source);
  }
  const roots = d.nodes.filter((n) => SERVICE_MAP[n.serviceId]?.provides.includes('client')).map((n) => n.id);
  if (!roots.length && d.nodes[0]) roots.push(d.nodes[0].id);
  const depth = new Map<string, number>();
  const q = [...roots];
  roots.forEach((r) => depth.set(r, 0));
  while (q.length) {
    const id = q.shift() as string;
    for (const nb of adj.get(id) ?? []) {
      if (!depth.has(nb)) {
        depth.set(nb, (depth.get(id) as number) + 1);
        q.push(nb);
      }
    }
  }
  const maxDepth = Math.max(0, ...depth.values());
  const layers = new Map<number, string[]>();
  for (const n of d.nodes) {
    const dep = depth.get(n.id) ?? maxDepth + 1;
    layers.set(dep, [...(layers.get(dep) ?? []), n.id]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  const tallest = Math.max(1, ...[...layers.values()].map((l) => l.length));
  for (const [dep, idsInLayer] of layers) {
    const offset = ((tallest - idsInLayer.length) * 120) / 2;
    idsInLayer.forEach((id, i) => pos.set(id, { x: 40 + dep * 270, y: 40 + offset + i * 120 }));
  }
  return { ...d, nodes: d.nodes.map((n) => ({ ...n, ...(pos.get(n.id) as { x: number; y: number }) })) };
}

/** Validate and normalise the model's reply. Never throws on bad content, only on non-JSON. */
export function parseDesign(text: string): AiResult {
  const raw = extractJson(text);
  if (!isObj(raw) || !Array.isArray(raw.nodes)) throw new Error('The reply had no "nodes" list.');
  const warnings: string[] = [];
  const idMap = new Map<string, string>();
  const nodes: DesignNode[] = [];

  for (const r of raw.nodes) {
    if (!isObj(r)) continue;
    const serviceId = String(r.service ?? r.serviceId ?? '');
    const rawId = String(r.id ?? `n${nodes.length + 1}`);
    if (!SERVICE_MAP[serviceId]) {
      warnings.push(`Dropped "${rawId}": "${serviceId}" is not a service in the catalog.`);
      continue;
    }
    let id = rawId.replace(/[^a-zA-Z0-9_-]/g, '_') || `n${nodes.length + 1}`;
    while (nodes.some((n) => n.id === id)) id += '_';
    idMap.set(rawId, id);
    nodes.push({
      id,
      serviceId,
      config: cleanConfig(serviceId, r.config, warnings),
      ...(isDbService(serviceId) && sanitizeSchema(r.schema) ? { schema: sanitizeSchema(r.schema) } : {}),
      x: 0,
      y: 0,
      ...(typeof r.label === 'string' && r.label.trim() ? { label: r.label.trim().slice(0, 40) } : {}),
    });
  }

  const edges: Design['edges'] = [];
  const seen = new Set<string>();
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    const pair = Array.isArray(e) ? e : isObj(e) ? [e.source ?? e.from, e.target ?? e.to] : [];
    const a = idMap.get(String(pair[0]));
    const b = idMap.get(String(pair[1]));
    if (!a || !b || a === b) {
      warnings.push(`Dropped edge ${String(pair[0])} -> ${String(pair[1])}: unknown node.`);
      continue;
    }
    const key = [a, b].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ id: `e${edges.length + 1}`, source: a, target: b });
  }

  if (!nodes.some((n) => SERVICE_MAP[n.serviceId].provides.includes('client'))) warnings.push('No client node, so nothing is reachable. Add one in the editor.');
  return {
    design: autoLayout({ nodes, edges }),
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
    warnings,
    workload: isObj(raw.workload) ? normalizeWorkload(raw.workload) : null,
  };
}

export const EXAMPLE_PROMPTS = [
  'A photo-sharing app for 5M daily users',
  'Live auction site with real-time bidding',
  'IoT telemetry pipeline for 100k devices',
  'Internal HR portal for 5k employees, as cheap as possible',
  'Multiplayer game leaderboard with global players',
  'Video-call scheduling SaaS, multi-tenant',
];

export const CONSTRAINT_PROMPTS = [
  'Make it survive the loss of a whole region',
  'Use only serverless services',
  'Handle a 10x traffic spike with no manual scaling',
  'Cut the monthly cost by half',
  'Add async processing so writes never block users',
];
