// Shared types for the System Design Studio.
// NOTE: keep this file (and everything in src/lib) free of non-erasable TS syntax
// (enums, namespaces, constructor parameter properties) so the evaluator can be
// unit-tested directly with `node --experimental-strip-types`.

export type Tier = 'beginner' | 'mid' | 'senior' | 'staff';

/** What a service can *do* in an architecture. Rubrics reason about capabilities, not product names. */
export type Capability =
  | 'client'
  | 'external'
  | 'compute'
  | 'lb'
  | 'cdn'
  | 'waf'
  | 'apigw'
  | 'ratelimit'
  | 'dns'
  | 'cache'
  | 'sql'
  | 'nosql'
  | 'wide-column'
  | 'global-db'
  | 'blob'
  | 'analytics'
  | 'search'
  | 'queue'
  | 'stream'
  | 'workflow'
  | 'scheduler'
  | 'stream-processing'
  | 'auth'
  | 'secrets'
  | 'push'
  | 'geo'
  | 'transcode'
  | 'ml'
  | 'observability';

export type Category =
  | 'Clients & External'
  | 'Compute'
  | 'Networking & Edge'
  | 'Databases'
  | 'Caching'
  | 'Storage'
  | 'Messaging & Streaming'
  | 'Data & AI'
  | 'Security & Identity'
  | 'Operations';

export type ConfigValue = number | string | boolean;
export type Config = Record<string, ConfigValue>;

export interface ConfigField {
  key: string;
  label: string;
  type: 'number' | 'select' | 'toggle';
  min?: number;
  max?: number;
  step?: number;
  /** Use a logarithmic slider (good for ranges spanning orders of magnitude). */
  log?: boolean;
  unit?: string;
  options?: { value: string; label: string }[];
  default: ConfigValue;
  help?: string;
}

/** Workload numbers handed to cost functions. */
export interface CostCtx {
  avgQps: number;
  peakQps: number;
  /** Fraction of requests that are reads (0..1). */
  readRatio: number;
  payloadKB: number;
  /** Fraction of traffic that is cacheable at the CDN edge (0..1). */
  cdnFriendly: number;
  storageGB: number;
  /** Compute work per request relative to a typical request (higher = lighter). */
  computeFactor: number;
  /** Fraction of reads that still reach the database after any cache (0..1). */
  readPassThrough: number;
}

export interface Capacity {
  qps?: number;
  readQps?: number;
  writeQps?: number;
  storageGB?: number;
}

export interface ServiceDef {
  id: string;
  name: string;
  category: Category;
  /** Key into the icon map in components/icons.tsx */
  icon: string;
  summary: string;
  /** One-line trade-off to help the learner decide. */
  tradeoff: string;
  provides: Capability[];
  fields: ConfigField[];
  /** Monthly USD. Receives a fully-resolved config. */
  cost: (c: Config, x: CostCtx) => number;
  capacity?: (c: Config) => Capacity;
  /** Fields (in order) bumped by Auto-size until capacity covers the load. */
  scaleFields?: string[];
  /** Field holding provisioned storage in GB (billed), if any. */
  storageField?: string;
  /** Typical added p95 latency (ms) on the synchronous request path. */
  latency?: (c: Config) => number;
  ha?: (c: Config) => boolean;
  multiRegion?: (c: Config) => boolean;
  /** Short one-liner shown on the canvas node. */
  chips?: (c: Config) => string;
}

// ---- Designs -------------------------------------------------------------

/** One field of a table, collection, row or cache key pattern. */
export interface SchemaField {
  name: string;
  type: string;
  /** pk = primary / partition / row key, sk = sort or clustering key, idx = secondary index, uq = unique */
  key?: '' | 'pk' | 'sk' | 'idx' | 'uq';
}

/** A table, collection, wide-column family or cache key pattern the learner says this store holds. */
export interface SchemaEntity {
  id: string;
  name: string;
  fields: SchemaField[];
  /** How this data is read and written (the access pattern). */
  note?: string;
}

export interface DesignNode {
  id: string;
  serviceId: string;
  config: Config;
  x: number;
  y: number;
  label?: string;
  /** Data model for database and cache nodes. */
  schema?: SchemaEntity[];
}

export interface DesignEdge {
  id: string;
  source: string;
  target: string;
}

export interface Design {
  nodes: DesignNode[];
  edges: DesignEdge[];
}

// ---- Problems ------------------------------------------------------------

export type ScoreCategory = 'scalability' | 'reliability' | 'performance' | 'fit' | 'cost';

export interface Scale {
  /** Human-readable audience size, e.g. "10M DAU". */
  audience: string;
  avgQps: number;
  peakQps: number;
  /** Fraction of requests that are reads (0..1). */
  readRatio: number;
  storageGB: number;
  /** Where the bulk of the data lives. */
  storageIn: 'db' | 'blob' | 'cache' | 'any';
  payloadKB: number;
  /** Fraction of traffic cacheable at the edge (0..1). */
  cdnFriendly: number;
  /** Fraction of reads that an in-memory cache can absorb (0..1). */
  cacheable: number;
  /** All hot-path operations hit the cache (rate limiter, ad targeting, ...). */
  cacheFirst: boolean;
  /** p95 latency budget in ms for the synchronous path. */
  latencyMs: number;
  availability: string;
  /** Reference monthly budget (USD). Spending well above this costs points. */
  budgetUSD: number;
  /** Scale-down disclaimer or other context. */
  note?: string;
  /** Internal platform traffic: no internet egress is billed. */
  internal?: boolean;
  /** How much lighter than a typical request each request is for compute (1 = typical; 8 = trivial work). */
  computeFactor?: number;
}

export interface RubricItem {
  req: string;
  weight?: number;
  /** Problem-specific coaching shown next to the requirement. */
  note?: string;
  /** Bonus items never hurt; they add up to a few extra points. */
  bonus?: boolean;
}

export interface DbFit {
  good: string[];
  ok: string[];
  bad: string[];
  note: string;
}

export interface Problem {
  id: string;
  title: string;
  tier: Tier;
  tagline: string;
  /** What interviewers use this problem to probe. */
  tags: string[];
  functional: string[];
  nonFunctional: string[];
  scale: Scale;
  dbFit?: DbFit;
  rubric: RubricItem[];
  /** Base rubric items (lb, observability, ...) that do not apply to this problem. */
  skipBase?: string[];
  pitfalls: string[];
  hints: string[];
}
