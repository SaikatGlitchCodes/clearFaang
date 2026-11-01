// GCP service catalog: tunable config, monthly cost model, capacity model.
//
// All prices are *approximate on-demand list prices* (us-central1-ish, USD) rounded for
// learning purposes. They ignore committed-use discounts, most free tiers, support plans
// and taxes. Capacity numbers are rules of thumb for sizing exercises, not SLAs.
// Always confirm against https://cloud.google.com/pricing before real budgeting.

import type {
  Capability,
  Capacity,
  Category,
  Config,
  ConfigField,
  CostCtx,
  ServiceDef,
} from './types';

export const HOURS = 730;
export const SECONDS_PER_MONTH = 2_592_000;
const SEC = SECONDS_PER_MONTH;

export const CATEGORY_ORDER: Category[] = [
  'Clients & External',
  'Networking & Edge',
  'Compute',
  'Caching',
  'Databases',
  'Storage',
  'Messaging & Streaming',
  'Data & AI',
  'Security & Identity',
  'Operations',
];

export const CATEGORY_HEX: Record<Category, string> = {
  'Clients & External': '#64748b',
  Compute: '#2563eb',
  'Networking & Edge': '#0d9488',
  Databases: '#7c3aed',
  Caching: '#dc2626',
  Storage: '#d97706',
  'Messaging & Streaming': '#db2777',
  'Data & AI': '#059669',
  'Security & Identity': '#4f46e5',
  Operations: '#475569',
};

// ---- helpers ---------------------------------------------------------------

const num = (c: Config, k: string): number => Number(c[k]);
const str = (c: Config, k: string): string => String(c[k]);
const bool = (c: Config, k: string): boolean => Boolean(c[k]);
const pct = (c: Config, k: string): number => Number(c[k]) / 100;

const opts = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

const shareField = (def = 100, help = 'Share of the overall workload that flows through this service'): ConfigField => ({
  key: 'share',
  label: 'Traffic share',
  type: 'number',
  min: 1,
  max: 100,
  step: 1,
  unit: '%',
  default: def,
  help,
});

const regionsField = (): ConfigField => ({
  key: 'regions',
  label: 'Regions',
  type: 'number',
  min: 1,
  max: 5,
  step: 1,
  default: 1,
  help: 'Run the same capacity in N regions. Cost scales linearly.',
});

const vcpuOptions = (...v: number[]) => v.map((n) => ({ value: String(n), label: `${n} vCPU` }));

const compact = (n: number): string => {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
};

const redisRatePerGB = (gb: number): number =>
  (gb <= 4 ? 0.064 : gb <= 10 ? 0.054 : gb <= 35 ? 0.046 : gb <= 100 ? 0.035 : 0.03) * HOURS;

function identityCost(mau: number): number {
  const tiers: [number, number][] = [
    [50_000, 0],
    [100_000, 0.0055],
    [1_000_000, 0.0046],
    [10_000_000, 0.0032],
    [Infinity, 0.0025],
  ];
  let prev = 0;
  let cost = 0;
  for (const [limit, rate] of tiers) {
    if (mau > prev) cost += (Math.min(mau, limit) - prev) * rate;
    prev = limit;
  }
  return cost;
}

const GCS_RATES: Record<string, { region: number; multi: number; opsMult: number; retrieval: number }> = {
  standard: { region: 0.02, multi: 0.026, opsMult: 1, retrieval: 0 },
  nearline: { region: 0.01, multi: 0.015, opsMult: 2, retrieval: 0.01 },
  coldline: { region: 0.004, multi: 0.007, opsMult: 5, retrieval: 0.02 },
  archive: { region: 0.0012, multi: 0.0025, opsMult: 10, retrieval: 0.05 },
};

const MACHINE_COST: Record<string, number> = {
  '2': 49,
  '4': 98,
  '8': 196,
  '16': 392,
  '32': 784,
  '64': 1568,
};

// ---- catalog ---------------------------------------------------------------

export const SERVICES: ServiceDef[] = [
  // ===== Clients & external ================================================
  {
    id: 'client',
    name: 'Web / Mobile Client',
    category: 'Clients & External',
    icon: 'Smartphone',
    summary: 'The entry point: browsers, mobile apps, partner systems.',
    tradeoff: 'Every design needs at least one. Connect it to your first hop (CDN, WAF, LB or API).',
    provides: ['client'],
    fields: [],
    cost: () => 0,
  },
  {
    id: 'external',
    name: 'Third-party Service',
    category: 'Clients & External',
    icon: 'Cable',
    summary: 'Card network, SMS/email provider, APNs, bank rail, etc.',
    tradeoff: 'Slow (~150 ms), rate-limited and flaky. Call it from workers behind a queue, not inline.',
    provides: ['external'],
    fields: [
      {
        key: 'kind',
        label: 'Kind',
        type: 'select',
        options: opts(['payment', 'Payment gateway / card network'], ['messaging', 'SMS / email / push provider'], ['other', 'Other API']),
        default: 'payment',
      },
    ],
    cost: () => 0,
    latency: () => 150,
    chips: (c) => str(c, 'kind'),
  },

  // ===== Compute ===========================================================
  {
    id: 'cloud-run',
    name: 'Cloud Run',
    category: 'Compute',
    icon: 'Server',
    summary: 'Serverless containers with request-based autoscaling and scale-to-zero.',
    tradeoff: 'Fast to ship and cheap at low load. Cold starts and per-instance limits make it a poor fit for ultra-low-latency or long-lived connections at scale.',
    provides: ['compute'],
    fields: [
      { key: 'vcpu', label: 'vCPU per instance', type: 'select', options: vcpuOptions(1, 2, 4), default: '1' },
      { key: 'maxInstances', label: 'Max instances', type: 'number', min: 1, max: 1000, step: 1, log: true, default: 10 },
      { key: 'minInstances', label: 'Min instances (warm)', type: 'number', min: 0, max: 100, step: 1, default: 1, help: 'Warm instances avoid cold starts and give you a floor of availability' },
      regionsField(),
      shareField(100, 'Use a lower share for background workers that only see a slice of the traffic'),
    ],
    cost: (c, x) => {
      const vcpu = num(c, 'vcpu');
      const regions = num(c, 'regions');
      const perInst = 150 * vcpu * x.computeFactor;
      const need = Math.ceil((x.avgQps * pct(c, 'share')) / regions / perInst);
      const inst = Math.min(num(c, 'maxInstances'), Math.max(num(c, 'minInstances'), need));
      return regions * inst * vcpu * 58;
    },
    capacity: (c) => ({ qps: num(c, 'maxInstances') * num(c, 'vcpu') * 150 * num(c, 'regions') }),
    scaleFields: ['maxInstances'],
    latency: () => 8,
    ha: () => true,
    multiRegion: (c) => num(c, 'regions') >= 2,
    chips: (c) => `${num(c, 'minInstances')}–${num(c, 'maxInstances')} inst · ${num(c, 'vcpu')} vCPU${num(c, 'regions') > 1 ? ` · ${num(c, 'regions')} regions` : ''}`,
  },
  {
    id: 'gke',
    name: 'GKE',
    category: 'Compute',
    icon: 'Boxes',
    summary: 'Managed Kubernetes. Full control over scheduling, networking and stateful workloads.',
    tradeoff: 'Powerful and predictable, but you own cluster design, upgrades and capacity planning. Pays off with many services or special hardware needs.',
    provides: ['compute'],
    fields: [
      { key: 'nodes', label: 'Nodes (per region)', type: 'number', min: 3, max: 500, step: 1, log: true, default: 3 },
      { key: 'machine', label: 'Node size', type: 'select', options: vcpuOptions(2, 4, 8, 16), default: '4' },
      regionsField(),
      shareField(),
    ],
    cost: (c) => num(c, 'regions') * (num(c, 'nodes') * MACHINE_COST[str(c, 'machine')] + 73),
    capacity: (c) => ({ qps: num(c, 'nodes') * num(c, 'machine') * 150 * 0.7 * num(c, 'regions') }),
    scaleFields: ['nodes'],
    latency: () => 5,
    ha: (c) => num(c, 'nodes') >= 3,
    multiRegion: (c) => num(c, 'regions') >= 2,
    chips: (c) => `${num(c, 'nodes')} × ${num(c, 'machine')} vCPU nodes${num(c, 'regions') > 1 ? ` · ${num(c, 'regions')} regions` : ''}`,
  },
  {
    id: 'gce',
    name: 'Compute Engine',
    category: 'Compute',
    icon: 'Cpu',
    summary: 'Raw VMs. Pin CPUs, tune the kernel, keep state in memory, pick any machine shape.',
    tradeoff: 'Lowest, steadiest latency and total control. You manage OS patching, autoscaling and failover yourself.',
    provides: ['compute'],
    fields: [
      { key: 'instances', label: 'Instances (per region)', type: 'number', min: 1, max: 500, step: 1, log: true, default: 2 },
      { key: 'machine', label: 'Machine size', type: 'select', options: vcpuOptions(2, 4, 8, 16, 32, 64), default: '4' },
      regionsField(),
      shareField(),
    ],
    cost: (c) => num(c, 'regions') * num(c, 'instances') * MACHINE_COST[str(c, 'machine')],
    capacity: (c) => ({ qps: num(c, 'instances') * num(c, 'machine') * 150 * num(c, 'regions') }),
    scaleFields: ['instances'],
    latency: () => 3,
    ha: (c) => num(c, 'instances') >= 2,
    multiRegion: (c) => num(c, 'regions') >= 2,
    chips: (c) => `${num(c, 'instances')} × ${num(c, 'machine')} vCPU VMs${num(c, 'regions') > 1 ? ` · ${num(c, 'regions')} regions` : ''}`,
  },
  {
    id: 'functions',
    name: 'Cloud Functions',
    category: 'Compute',
    icon: 'Zap',
    summary: 'Event-driven functions. Pay per invocation, zero ops.',
    tradeoff: 'Great for glue code and bursty background work. Per-instance throughput is low and cold starts hurt latency-critical paths.',
    provides: ['compute'],
    fields: [
      { key: 'maxInstances', label: 'Max instances', type: 'number', min: 1, max: 3000, step: 1, log: true, default: 50 },
      regionsField(),
      shareField(),
    ],
    cost: (c, x) => ((x.avgQps * pct(c, 'share') * SEC) / 1e6) * 1.3,
    capacity: (c) => ({ qps: num(c, 'maxInstances') * 20 * num(c, 'regions') }),
    scaleFields: ['maxInstances'],
    latency: () => 25,
    ha: () => true,
    multiRegion: (c) => num(c, 'regions') >= 2,
    chips: (c) => `max ${num(c, 'maxInstances')} inst`,
  },

  // ===== Networking & edge =================================================
  {
    id: 'lb',
    name: 'Cloud Load Balancing',
    category: 'Networking & Edge',
    icon: 'Network',
    summary: 'Global external Application Load Balancer with anycast IP, TLS termination and health checks.',
    tradeoff: 'Spreads load, hides instance failures and enables multi-region routing. Costs little compared with the risk it removes.',
    provides: ['lb'],
    fields: [
      { key: 'rules', label: 'Forwarding rules', type: 'number', min: 1, max: 10, step: 1, default: 1 },
      shareField(),
    ],
    cost: (c, x) => num(c, 'rules') * 18.25 + ((x.avgQps * pct(c, 'share') * SEC * x.payloadKB) / 1e6) * 0.008,
    latency: () => 2,
    ha: () => true,
    multiRegion: () => true,
    chips: (c) => `${num(c, 'rules')} rule${num(c, 'rules') > 1 ? 's' : ''}`,
  },
  {
    id: 'cdn',
    name: 'Cloud CDN',
    category: 'Networking & Edge',
    icon: 'Globe',
    summary: 'Edge caching in front of the load balancer or a storage bucket.',
    tradeoff: 'Slashes origin load and latency for cacheable content. Useless (and slightly costly) for personalised or write-heavy traffic.',
    provides: ['cdn'],
    fields: [
      { key: 'hitRatio', label: 'Cache hit ratio', type: 'number', min: 50, max: 99, step: 1, unit: '%', default: 85, help: 'Depends on cache keys, TTLs and content popularity' },
      shareField(100, 'Share of the cacheable traffic that goes through this CDN'),
    ],
    cost: (c, x) => {
      const hit = pct(c, 'hitRatio');
      const gb = ((x.avgQps * SEC * x.payloadKB) / 1e6) * x.cdnFriendly * pct(c, 'share');
      const reqs = x.avgQps * SEC * x.cdnFriendly * pct(c, 'share');
      return gb * 0.06 + gb * (1 - hit) * 0.04 + (reqs / 10_000) * 0.0075;
    },
    latency: () => 8,
    ha: () => true,
    multiRegion: () => true,
    chips: (c) => `${num(c, 'hitRatio')}% hit`,
  },
  {
    id: 'media-cdn',
    name: 'Media CDN',
    category: 'Networking & Edge',
    icon: 'Film',
    summary: 'Google edge cache tuned for large video/object delivery with long-tail catalogs.',
    tradeoff: 'Cheaper egress and higher hit ratios for streaming than general CDN, but only worth it at media scale.',
    provides: ['cdn'],
    fields: [
      { key: 'hitRatio', label: 'Cache hit ratio', type: 'number', min: 50, max: 99, step: 1, unit: '%', default: 95 },
      shareField(100, 'Share of the cacheable traffic that goes through this CDN'),
    ],
    cost: (c, x) => {
      const hit = pct(c, 'hitRatio');
      const gb = ((x.avgQps * SEC * x.payloadKB) / 1e6) * x.cdnFriendly * pct(c, 'share');
      const reqs = x.avgQps * SEC * x.cdnFriendly * pct(c, 'share');
      return gb * 0.04 + gb * (1 - hit) * 0.02 + (reqs / 10_000) * 0.0075;
    },
    latency: () => 8,
    ha: () => true,
    multiRegion: () => true,
    chips: (c) => `${num(c, 'hitRatio')}% hit`,
  },
  {
    id: 'armor',
    name: 'Cloud Armor',
    category: 'Networking & Edge',
    icon: 'Shield',
    summary: 'WAF, DDoS protection and edge rate limiting policies.',
    tradeoff: 'Blocks abuse before it reaches your compute. Edge rate limits are coarse (per IP / header), not per-business-rule.',
    provides: ['waf', 'ratelimit'],
    fields: [
      { key: 'rules', label: 'Policy rules', type: 'number', min: 1, max: 100, step: 1, default: 5 },
      shareField(),
    ],
    cost: (c, x) => 5 + num(c, 'rules') + ((x.avgQps * pct(c, 'share') * SEC) / 1e6) * 0.75,
    latency: () => 1,
    ha: () => true,
    multiRegion: () => true,
    chips: (c) => `${num(c, 'rules')} rules`,
  },
  {
    id: 'apigw',
    name: 'API Gateway',
    category: 'Networking & Edge',
    icon: 'Waypoints',
    summary: 'Managed API front door: auth, quotas, per-key rate limiting, routing.',
    tradeoff: 'Gives per-consumer quotas and a single policy point. Adds a hop and per-call cost; not meant for million-QPS data planes.',
    provides: ['apigw', 'ratelimit'],
    fields: [shareField()],
    cost: (c, x) => Math.max(0, (x.avgQps * pct(c, 'share') * SEC) / 1e6 - 2) * 3,
    latency: () => 6,
    ha: () => true,
    chips: (c) => `${num(c, 'share')}% of traffic`,
  },
  {
    id: 'dns',
    name: 'Cloud DNS',
    category: 'Networking & Edge',
    icon: 'Globe',
    summary: 'Authoritative DNS with latency/geo routing policies.',
    tradeoff: 'Cheap and highly available. Geo/latency routing is the cheapest way to steer users to the nearest region.',
    provides: ['dns'],
    fields: [],
    cost: (_c, x) => 0.2 + ((x.avgQps * 0.005 * SEC) / 1e6) * 0.4,
    ha: () => true,
    multiRegion: () => true,
  },

  // ===== Databases =========================================================
  {
    id: 'cloud-sql',
    name: 'Cloud SQL',
    category: 'Databases',
    icon: 'Database',
    summary: 'Managed PostgreSQL / MySQL. Full SQL, joins and ACID transactions on a single primary.',
    tradeoff: 'Familiar and cheap. One writer: write throughput and storage hit a ceiling, and cross-region failover is async.',
    provides: ['sql'],
    fields: [
      { key: 'vcpu', label: 'Primary size', type: 'select', options: vcpuOptions(2, 4, 8, 16, 32, 64), default: '4' },
      { key: 'ha', label: 'High availability (standby in 2nd zone)', type: 'toggle', default: false },
      { key: 'readReplicas', label: 'Read replicas', type: 'number', min: 0, max: 10, step: 1, default: 0 },
      { key: 'storageGB', label: 'SSD storage', type: 'number', min: 10, max: 65536, step: 10, log: true, unit: 'GB', default: 100 },
      { key: 'crossRegion', label: 'Cross-region replica', type: 'toggle', default: false, help: 'Async replica for DR / regional reads. Not strongly consistent.' },
    ],
    cost: (c) => {
      const inst = num(c, 'vcpu') * 51;
      const storage = num(c, 'storageGB') * 0.17;
      const mult = bool(c, 'ha') ? 2 : 1;
      return (
        (inst + storage) * mult +
        num(c, 'readReplicas') * (inst + storage) +
        (bool(c, 'crossRegion') ? inst + storage : 0)
      );
    },
    capacity: (c) => ({
      writeQps: num(c, 'vcpu') * 400,
      readQps: num(c, 'vcpu') * 1200 * (1 + num(c, 'readReplicas')),
      storageGB: Math.min(num(c, 'storageGB'), 65536),
    }),
    scaleFields: ['vcpu', 'readReplicas'],
    storageField: 'storageGB',
    latency: () => 6,
    ha: (c) => bool(c, 'ha'),
    multiRegion: (c) => bool(c, 'crossRegion'),
    chips: (c) => `${num(c, 'vcpu')} vCPU${bool(c, 'ha') ? ' · HA' : ''}${num(c, 'readReplicas') ? ` · ${num(c, 'readReplicas')} replicas` : ''}`,
  },
  {
    id: 'alloydb',
    name: 'AlloyDB',
    category: 'Databases',
    icon: 'DatabaseZap',
    summary: 'PostgreSQL-compatible with a fast, shared storage layer and read pools.',
    tradeoff: 'Several times faster than vanilla Postgres for mixed workloads. Still a single writer, and pricier than Cloud SQL.',
    provides: ['sql'],
    fields: [
      { key: 'vcpu', label: 'Primary size', type: 'select', options: vcpuOptions(2, 4, 8, 16, 32, 64), default: '4' },
      { key: 'ha', label: 'High availability', type: 'toggle', default: true },
      { key: 'readPools', label: 'Read pool nodes', type: 'number', min: 0, max: 20, step: 1, default: 0 },
      { key: 'storageGB', label: 'Storage', type: 'number', min: 10, max: 131072, step: 10, log: true, unit: 'GB', default: 100 },
      { key: 'crossRegion', label: 'Cross-region secondary cluster', type: 'toggle', default: false },
    ],
    cost: (c) => {
      const inst = num(c, 'vcpu') * 114;
      const storage = num(c, 'storageGB') * 0.3;
      return (
        inst * (bool(c, 'ha') ? 2 : 1) +
        storage +
        num(c, 'readPools') * inst +
        (bool(c, 'crossRegion') ? inst + storage : 0)
      );
    },
    capacity: (c) => ({
      writeQps: num(c, 'vcpu') * 600,
      readQps: num(c, 'vcpu') * 1800 * (1 + num(c, 'readPools')),
      storageGB: Math.min(num(c, 'storageGB'), 131072),
    }),
    scaleFields: ['vcpu', 'readPools'],
    storageField: 'storageGB',
    latency: () => 5,
    ha: (c) => bool(c, 'ha'),
    multiRegion: (c) => bool(c, 'crossRegion'),
    chips: (c) => `${num(c, 'vcpu')} vCPU${bool(c, 'ha') ? ' · HA' : ''}${num(c, 'readPools') ? ` · ${num(c, 'readPools')} pool nodes` : ''}`,
  },
  {
    id: 'spanner',
    name: 'Cloud Spanner',
    category: 'Databases',
    icon: 'Layers',
    summary: 'Horizontally scalable relational database with externally consistent global transactions.',
    tradeoff: 'The only option here with SQL + ACID + horizontal scale + multi-region strong consistency. Expensive, and cross-region writes pay a latency tax.',
    provides: ['sql', 'global-db'],
    fields: [
      { key: 'nodes', label: 'Nodes', type: 'number', min: 1, max: 100, step: 1, log: true, default: 1, help: '1 node = 1000 processing units' },
      { key: 'config', label: 'Configuration', type: 'select', options: opts(['regional', 'Regional (3 zones)'], ['multi', 'Multi-region']), default: 'regional' },
      { key: 'storageGB', label: 'Storage', type: 'number', min: 10, max: 400000, step: 10, log: true, unit: 'GB', default: 100 },
    ],
    cost: (c) => {
      const multi = str(c, 'config') === 'multi';
      return num(c, 'nodes') * (multi ? 2700 : 720) + num(c, 'storageGB') * (multi ? 0.5 : 0.3);
    },
    capacity: (c) => ({
      readQps: num(c, 'nodes') * 10_000,
      writeQps: num(c, 'nodes') * 2_000,
      storageGB: Math.min(num(c, 'storageGB'), num(c, 'nodes') * 4096),
    }),
    scaleFields: ['nodes'],
    storageField: 'storageGB',
    latency: (c) => 12 + (str(c, 'config') === 'multi' ? 30 : 0),
    ha: () => true,
    multiRegion: (c) => str(c, 'config') === 'multi',
    chips: (c) => `${num(c, 'nodes')} node${num(c, 'nodes') > 1 ? 's' : ''} · ${str(c, 'config') === 'multi' ? 'multi-region' : 'regional'}`,
  },
  {
    id: 'firestore',
    name: 'Firestore',
    category: 'Databases',
    icon: 'FileText',
    summary: 'Serverless document database with real-time sync and automatic scaling.',
    tradeoff: 'Zero ops and elastic, pay per operation. Limited query shapes and a hot-document write ceiling (~1 write/s per doc).',
    provides: ['nosql'],
    fields: [
      { key: 'storageGB', label: 'Storage', type: 'number', min: 1, max: 100000, step: 1, log: true, unit: 'GB', default: 10 },
      { key: 'multiRegion', label: 'Multi-region (nam5 / eur3)', type: 'toggle', default: false },
      shareField(),
    ],
    cost: (c, x) => {
      const mr = bool(c, 'multiRegion');
      const ops = x.avgQps * pct(c, 'share') * SEC;
      const reads = (ops * x.readRatio * x.readPassThrough) / 1e6;
      const writes = (ops * (1 - x.readRatio)) / 1e6;
      return reads * (mr ? 0.9 : 0.6) + writes * (mr ? 2.7 : 1.8) + num(c, 'storageGB') * (mr ? 0.26 : 0.18);
    },
    capacity: (c) => ({ readQps: 100_000, writeQps: 10_000, storageGB: num(c, 'storageGB') }),
    storageField: 'storageGB',
    latency: () => 14,
    ha: () => true,
    multiRegion: (c) => bool(c, 'multiRegion'),
    chips: (c) => (bool(c, 'multiRegion') ? 'multi-region' : 'regional'),
  },
  {
    id: 'bigtable',
    name: 'Cloud Bigtable',
    category: 'Databases',
    icon: 'Archive',
    summary: 'Wide-column NoSQL for huge, write-heavy, low-latency key-range workloads.',
    tradeoff: 'Linear scale to millions of ops/s at single-digit ms. No joins, no secondary indexes, and a single cluster lives in one zone.',
    provides: ['wide-column', 'nosql'],
    fields: [
      { key: 'nodes', label: 'Nodes per cluster', type: 'number', min: 1, max: 200, step: 1, log: true, default: 3 },
      { key: 'clusters', label: 'Clusters (replication)', type: 'number', min: 1, max: 3, step: 1, default: 1, help: '2+ clusters give HA and multi-region reads' },
      { key: 'storageType', label: 'Disk', type: 'select', options: opts(['ssd', 'SSD'], ['hdd', 'HDD (cheap, slow)']), default: 'ssd' },
      { key: 'storageGB', label: 'Stored data', type: 'number', min: 10, max: 2_000_000, step: 10, log: true, unit: 'GB', default: 500 },
    ],
    cost: (c) => {
      const ssd = str(c, 'storageType') === 'ssd';
      return num(c, 'clusters') * (num(c, 'nodes') * 474.5 + num(c, 'storageGB') * (ssd ? 0.17 : 0.026));
    },
    capacity: (c) => {
      const ssd = str(c, 'storageType') === 'ssd';
      return {
        readQps: num(c, 'clusters') * num(c, 'nodes') * (ssd ? 10_000 : 500),
        writeQps: num(c, 'nodes') * (ssd ? 10_000 : 5_000),
        storageGB: Math.min(num(c, 'storageGB'), num(c, 'nodes') * (ssd ? 5_000 : 16_000)),
      };
    },
    scaleFields: ['nodes'],
    storageField: 'storageGB',
    latency: (c) => (str(c, 'storageType') === 'ssd' ? 6 : 20),
    ha: (c) => num(c, 'clusters') >= 2,
    multiRegion: (c) => num(c, 'clusters') >= 2,
    chips: (c) => `${num(c, 'nodes')} nodes × ${num(c, 'clusters')} cluster${num(c, 'clusters') > 1 ? 's' : ''} · ${str(c, 'storageType')}`,
  },

  // ===== Caching ===========================================================
  {
    id: 'memorystore',
    name: 'Memorystore (Redis)',
    category: 'Caching',
    icon: 'Flame',
    summary: 'Managed Redis. Sub-millisecond reads, counters, locks, leaderboards, sessions.',
    tradeoff: 'Blazing fast but memory-priced and a single primary caps throughput (~100k ops/s). Standard tier adds failover; data can still be lost on failover.',
    provides: ['cache'],
    fields: [
      { key: 'sizeGB', label: 'Memory', type: 'number', min: 1, max: 300, step: 1, log: true, unit: 'GB', default: 5 },
      { key: 'tier', label: 'Tier', type: 'select', options: opts(['basic', 'Basic (no failover)'], ['standard', 'Standard (HA replica)']), default: 'standard' },
      { key: 'hitRatio', label: 'Expected hit ratio', type: 'number', min: 30, max: 99, step: 1, unit: '%', default: 90, help: 'Assumption used by the estimator. Depends on TTLs, key skew and working-set size.' },
    ],
    cost: (c) => {
      const gb = num(c, 'sizeGB');
      return gb * redisRatePerGB(gb) * (str(c, 'tier') === 'basic' ? 0.75 : 1);
    },
    capacity: (c) => ({ qps: 100_000, storageGB: num(c, 'sizeGB') }),
    scaleFields: ['sizeGB'],
    latency: () => 1.2,
    ha: (c) => str(c, 'tier') === 'standard',
    multiRegion: () => false,
    chips: (c) => `${num(c, 'sizeGB')} GB · ${str(c, 'tier')} · ${num(c, 'hitRatio')}% hit`,
  },
  {
    id: 'memorystore-cluster',
    name: 'Memorystore Cluster',
    category: 'Caching',
    icon: 'Flame',
    summary: 'Sharded Redis Cluster for hundreds of thousands to millions of ops/s and terabytes of RAM.',
    tradeoff: 'Scales throughput and memory horizontally with replicas per shard. Costs real money and needs cluster-aware clients.',
    provides: ['cache'],
    fields: [
      { key: 'shards', label: 'Shards', type: 'number', min: 3, max: 250, step: 1, log: true, default: 3 },
      { key: 'replicas', label: 'Replicas per shard', type: 'select', options: opts(['0', '0 (no HA)'], ['1', '1'], ['2', '2']), default: '1' },
      { key: 'hitRatio', label: 'Expected hit ratio', type: 'number', min: 30, max: 99, step: 1, unit: '%', default: 92 },
    ],
    cost: (c) => num(c, 'shards') * (1 + num(c, 'replicas')) * 390,
    capacity: (c) => ({ qps: num(c, 'shards') * 100_000, storageGB: num(c, 'shards') * 13 * 0.85 }),
    scaleFields: ['shards'],
    latency: () => 1.5,
    ha: (c) => num(c, 'replicas') >= 1,
    multiRegion: () => false,
    chips: (c) => `${num(c, 'shards')} shards × ${1 + num(c, 'replicas')} nodes`,
  },

  // ===== Storage ===========================================================
  {
    id: 'gcs',
    name: 'Cloud Storage',
    category: 'Storage',
    icon: 'HardDrive',
    summary: 'Durable object storage (11 nines) for blobs: files, images, video, backups, exports.',
    tradeoff: 'Cheapest place for big immutable data with effectively unlimited capacity. Not a database: no queries, and per-object write rates are limited.',
    provides: ['blob'],
    fields: [
      { key: 'storageGB', label: 'Stored data', type: 'number', min: 1, max: 10_000_000, step: 1, log: true, unit: 'GB', default: 1000 },
      { key: 'storageClass', label: 'Class', type: 'select', options: opts(['standard', 'Standard'], ['nearline', 'Nearline (monthly)'], ['coldline', 'Coldline (quarterly)'], ['archive', 'Archive (yearly)']), default: 'standard' },
      { key: 'location', label: 'Location', type: 'select', options: opts(['region', 'Single region'], ['multi', 'Multi-region']), default: 'region' },
      shareField(30, 'Share of requests that read or write objects in this bucket'),
    ],
    cost: (c, x) => {
      const r = GCS_RATES[str(c, 'storageClass')];
      const multi = str(c, 'location') === 'multi';
      const ops = x.avgQps * pct(c, 'share') * SEC;
      const reads = ops * x.readRatio;
      const writes = ops * (1 - x.readRatio);
      const readGB = (reads * x.payloadKB) / 1e6;
      return (
        num(c, 'storageGB') * (multi ? r.multi : r.region) +
        ((writes / 1e6) * 5 + (reads / 1e6) * 0.4) * r.opsMult +
        readGB * r.retrieval
      );
    },
    capacity: (c) => ({ storageGB: num(c, 'storageGB') }),
    storageField: 'storageGB',
    latency: () => 35,
    ha: () => true,
    multiRegion: (c) => str(c, 'location') === 'multi',
    chips: (c) => `${compact(num(c, 'storageGB'))} GB · ${str(c, 'storageClass')}${str(c, 'location') === 'multi' ? ' · multi-region' : ''}`,
  },

  // ===== Messaging & streaming ============================================
  {
    id: 'pubsub',
    name: 'Pub/Sub',
    category: 'Messaging & Streaming',
    icon: 'Radio',
    summary: 'Global, serverless message bus with at-least-once delivery, fan-out and dead-letter topics.',
    tradeoff: 'Effortless scale and decoupling. Ordering is per-key only, there is no partition control, and consumers must be idempotent.',
    provides: ['queue'],
    fields: [
      { key: 'msgKB', label: 'Avg message size', type: 'number', min: 0.1, max: 1000, step: 0.1, log: true, unit: 'KB', default: 2 },
      { key: 'subscribers', label: 'Subscriptions (fan-out)', type: 'number', min: 1, max: 10, step: 1, default: 1 },
      shareField(30, 'Share of requests that publish a message (writes and events, not reads)'),
    ],
    cost: (c, x) => {
      const gb = (x.avgQps * pct(c, 'share') * SEC * num(c, 'msgKB')) / 1e6;
      return Math.max(0, gb * (1 + num(c, 'subscribers')) - 10) * 0.04;
    },
    ha: () => true,
    chips: (c) => `${num(c, 'subscribers')} sub${num(c, 'subscribers') > 1 ? 's' : ''} · ${num(c, 'share')}% traffic`,
  },
  {
    id: 'kafka',
    name: 'Managed Kafka',
    category: 'Messaging & Streaming',
    icon: 'ListOrdered',
    summary: 'Google Cloud Managed Service for Apache Kafka: partitioned, replayable, ordered log.',
    tradeoff: 'Per-partition ordering, replay and huge throughput, but you size brokers, partitions and consumer groups. Always-on cost.',
    provides: ['queue', 'stream'],
    fields: [
      { key: 'brokers', label: 'Brokers', type: 'number', min: 3, max: 30, step: 1, default: 3 },
      { key: 'vcpu', label: 'vCPU per broker', type: 'select', options: vcpuOptions(4, 8, 16), default: '4' },
      { key: 'storageGB', label: 'Retained data (before 3× replication)', type: 'number', min: 10, max: 1_000_000, step: 10, log: true, unit: 'GB', default: 500 },
    ],
    cost: (c) => num(c, 'brokers') * num(c, 'vcpu') * 65.7 + num(c, 'storageGB') * 3 * 0.17,
    capacity: (c) => ({ qps: num(c, 'brokers') * num(c, 'vcpu') * 8_000, storageGB: num(c, 'storageGB') }),
    scaleFields: ['brokers'],
    storageField: 'storageGB',
    ha: (c) => num(c, 'brokers') >= 3,
    chips: (c) => `${num(c, 'brokers')} brokers × ${num(c, 'vcpu')} vCPU`,
  },
  {
    id: 'tasks',
    name: 'Cloud Tasks',
    category: 'Messaging & Streaming',
    icon: 'ListOrdered',
    summary: 'Managed task queues with rate limits, retries and scheduled delivery to HTTP targets.',
    tradeoff: 'Perfect for throttled, targeted work (call a vendor at 50 rps). Each queue is capped around 500 dispatches/s.',
    provides: ['queue'],
    fields: [
      { key: 'queues', label: 'Queues', type: 'number', min: 1, max: 50, step: 1, default: 1 },
      shareField(30, 'Share of requests that enqueue a task'),
    ],
    cost: (c, x) => Math.max(0, (x.avgQps * pct(c, 'share') * SEC) / 1e6 - 1) * 0.4,
    capacity: (c) => ({ qps: num(c, 'queues') * 500 }),
    scaleFields: ['queues'],
    ha: () => true,
    chips: (c) => `${num(c, 'queues')} queue${num(c, 'queues') > 1 ? 's' : ''}`,
  },
  {
    id: 'workflows',
    name: 'Workflows',
    category: 'Messaging & Streaming',
    icon: 'Workflow',
    summary: 'Serverless orchestration: sequences, retries, compensations (sagas), human-in-the-loop waits.',
    tradeoff: 'Makes multi-step business processes explicit and recoverable. Adds per-step cost and latency; not for hot paths.',
    provides: ['workflow'],
    fields: [
      { key: 'stepsPerRun', label: 'Steps per run', type: 'number', min: 1, max: 100, step: 1, default: 6 },
      { key: 'share', label: 'Traffic share', type: 'number', min: 0.1, max: 100, step: 0.1, log: true, unit: '%', default: 0.5, help: 'Share of requests that start a workflow run (for example checkouts)' },
    ],
    cost: (c, x) => ((x.avgQps * pct(c, 'share') * SEC * num(c, 'stepsPerRun')) / 1000) * 0.01,
    ha: () => true,
    chips: (c) => `${num(c, 'stepsPerRun')} steps · ${num(c, 'share')}% traffic`,
  },
  {
    id: 'scheduler',
    name: 'Cloud Scheduler',
    category: 'Messaging & Streaming',
    icon: 'Clock',
    summary: 'Managed cron: trigger HTTP endpoints or Pub/Sub topics on a schedule.',
    tradeoff: 'Reliable and basically free. Jobs must be idempotent; it triggers work, it does not run it.',
    provides: ['scheduler'],
    fields: [{ key: 'jobs', label: 'Jobs', type: 'number', min: 1, max: 100, step: 1, default: 3 }],
    cost: (c) => Math.max(0, num(c, 'jobs') - 3) * 0.1,
    ha: () => true,
    chips: (c) => `${num(c, 'jobs')} jobs`,
  },
  {
    id: 'dataflow',
    name: 'Dataflow',
    category: 'Messaging & Streaming',
    icon: 'Activity',
    summary: 'Managed Apache Beam: streaming and batch pipelines with autoscaling and exactly-once processing.',
    tradeoff: 'Best choice for windowed aggregation, enrichment and ETL at scale. Worker-hour billing makes always-on streaming jobs a steady cost.',
    provides: ['stream-processing'],
    fields: [
      { key: 'workers', label: 'Workers', type: 'number', min: 1, max: 200, step: 1, log: true, default: 2 },
      { key: 'mode', label: 'Mode', type: 'select', options: opts(['streaming', 'Streaming (always on)'], ['batch', 'Batch (~40% duty)']), default: 'streaming' },
    ],
    cost: (c) => num(c, 'workers') * (str(c, 'mode') === 'streaming' ? 240 : 100),
    capacity: (c) => ({ qps: num(c, 'workers') * 5_000 }),
    scaleFields: ['workers'],
    ha: () => true,
    chips: (c) => `${num(c, 'workers')} workers · ${str(c, 'mode')}`,
  },

  // ===== Data & AI =========================================================
  {
    id: 'bigquery',
    name: 'BigQuery',
    category: 'Data & AI',
    icon: 'BarChart3',
    summary: 'Serverless data warehouse for analytics over terabytes to petabytes.',
    tradeoff: 'Superb for analytics, reconciliation and ML features. Never the OLTP store: seconds of latency, and queries are billed by bytes scanned.',
    provides: ['analytics'],
    fields: [
      { key: 'storageGB', label: 'Stored data', type: 'number', min: 1, max: 5_000_000, step: 1, log: true, unit: 'GB', default: 1000 },
      { key: 'scannedTiB', label: 'Scanned per month', type: 'number', min: 0, max: 5000, step: 1, log: false, unit: 'TiB', default: 5 },
    ],
    cost: (c) => num(c, 'storageGB') * 0.02 + Math.max(0, num(c, 'scannedTiB') - 1) * 6.25,
    capacity: (c) => ({ storageGB: num(c, 'storageGB') }),
    storageField: 'storageGB',
    ha: () => true,
    multiRegion: () => false,
    chips: (c) => `${compact(num(c, 'storageGB'))} GB · ${num(c, 'scannedTiB')} TiB/mo scanned`,
  },
  {
    id: 'vertex-search',
    name: 'Vertex AI Search',
    category: 'Data & AI',
    icon: 'Search',
    summary: 'Managed search and retrieval with ranking, synonyms, facets and semantic matching.',
    tradeoff: 'Saves months of building search infrastructure. Priced per query and not ideal for exotic custom ranking.',
    provides: ['search'],
    fields: [shareField(5, 'Share of requests that are search queries')],
    cost: (c, x) => ((x.avgQps * pct(c, 'share') * SEC) / 1000) * 1.5,
    capacity: () => ({ qps: 2000 }),
    latency: () => 60,
    ha: () => true,
    chips: (c) => `${num(c, 'share')}% of traffic`,
  },
  {
    id: 'elasticsearch',
    name: 'Elasticsearch on GKE',
    category: 'Data & AI',
    icon: 'Search',
    summary: 'Self-managed Elasticsearch / OpenSearch cluster on GKE (Elastic Cloud is the managed alternative).',
    tradeoff: 'A flat node bill beats per-query pricing at high QPS and gives full control over analysers and ranking. You operate shards, upgrades and capacity yourself.',
    provides: ['search'],
    fields: [
      { key: 'nodes', label: 'Data nodes', type: 'number', min: 3, max: 100, step: 1, log: true, default: 3 },
      { key: 'machine', label: 'Node size', type: 'select', options: vcpuOptions(4, 8, 16), default: '8' },
      { key: 'storageGB', label: 'Index storage (with replicas)', type: 'number', min: 10, max: 500000, step: 10, log: true, unit: 'GB', default: 500 },
      shareField(5, 'Share of requests that are search queries (used for sizing)'),
    ],
    cost: (c) => num(c, 'nodes') * MACHINE_COST[str(c, 'machine')] + num(c, 'storageGB') * 0.17,
    capacity: (c) => ({ qps: num(c, 'nodes') * num(c, 'machine') * 100 }),
    scaleFields: ['nodes'],
    latency: () => 40,
    ha: (c) => num(c, 'nodes') >= 3,
    chips: (c) => `${num(c, 'nodes')} × ${num(c, 'machine')} vCPU nodes`,
  },
  {
    id: 'vertex-ml',
    name: 'Vertex AI Prediction',
    category: 'Data & AI',
    icon: 'Brain',
    summary: 'Online model serving: ranking, pricing, ETA, fraud and ad-prediction models.',
    tradeoff: 'Managed autoscaling endpoints with GPUs/CPUs. Adds tens of ms and a node-hour bill even at idle.',
    provides: ['ml'],
    fields: [{ key: 'nodes', label: 'Serving nodes', type: 'number', min: 1, max: 50, step: 1, default: 2 }],
    cost: (c) => num(c, 'nodes') * 160,
    capacity: (c) => ({ qps: num(c, 'nodes') * 200 }),
    scaleFields: ['nodes'],
    latency: () => 25,
    ha: (c) => num(c, 'nodes') >= 2,
    chips: (c) => `${num(c, 'nodes')} nodes`,
  },
  {
    id: 'maps',
    name: 'Maps Platform',
    category: 'Data & AI',
    icon: 'MapPin',
    summary: 'Routes, Places, Geocoding and Distance Matrix APIs.',
    tradeoff: 'Accurate routing and ETAs without building a map stack. Billed per request, so cache aggressively and call it sparingly.',
    provides: ['geo'],
    fields: [{ key: 'requestsM', label: 'Requests per month', type: 'number', min: 0.01, max: 100, step: 0.01, log: true, unit: 'M', default: 0.5 }],
    cost: (c) => num(c, 'requestsM') * 1000 * 5,
    latency: () => 60,
    ha: () => true,
    chips: (c) => `${num(c, 'requestsM')}M req/mo`,
  },
  {
    id: 'transcoder',
    name: 'Transcoder API',
    category: 'Data & AI',
    icon: 'Film',
    summary: 'Managed video transcoding into adaptive-bitrate ladders (HLS/DASH).',
    tradeoff: 'No FFmpeg fleet to run. Billed per output minute, so the ladder size is the cost lever.',
    provides: ['transcode'],
    fields: [
      { key: 'minutes', label: 'Source minutes per month', type: 'number', min: 100, max: 10_000_000, step: 100, log: true, default: 100_000 },
      { key: 'rungs', label: 'Bitrate ladder rungs', type: 'number', min: 1, max: 8, step: 1, default: 3 },
    ],
    cost: (c) => num(c, 'minutes') * num(c, 'rungs') * 0.02,
    ha: () => true,
    chips: (c) => `${compact(num(c, 'minutes'))} min/mo × ${num(c, 'rungs')}`,
  },

  // ===== Security & identity ===============================================
  {
    id: 'identity',
    name: 'Identity Platform',
    category: 'Security & Identity',
    icon: 'Users',
    summary: 'Customer identity: sign-in, social/SAML/OIDC, MFA, multi-tenancy (Firebase Auth compatible).',
    tradeoff: 'Do not hand-roll auth. Priced per monthly active user, which grows with success.',
    provides: ['auth'],
    fields: [{ key: 'mau', label: 'Monthly active users', type: 'number', min: 1000, max: 50_000_000, step: 1000, log: true, default: 100_000 }],
    cost: (c) => identityCost(num(c, 'mau')),
    latency: () => 5,
    ha: () => true,
    chips: (c) => `${compact(num(c, 'mau'))} MAU`,
  },
  {
    id: 'secret-manager',
    name: 'Secret Manager',
    category: 'Security & Identity',
    icon: 'KeyRound',
    summary: 'Store API keys, passwords and certificates with IAM, versioning and audit logs.',
    tradeoff: 'Almost free and removes secrets from code and images.',
    provides: ['secrets'],
    fields: [{ key: 'secrets', label: 'Secrets', type: 'number', min: 1, max: 1000, step: 1, default: 20 }],
    cost: (c) => 1 + num(c, 'secrets') * 0.06,
    ha: () => true,
    chips: (c) => `${num(c, 'secrets')} secrets`,
  },
  {
    id: 'kms',
    name: 'Cloud KMS / HSM',
    category: 'Security & Identity',
    icon: 'Lock',
    summary: 'Managed encryption keys, envelope encryption, signing, optional HSM protection.',
    tradeoff: 'Required for payment-grade key custody. HSM-backed keys cost about 16× software keys.',
    provides: ['secrets'],
    fields: [
      { key: 'keys', label: 'Key versions', type: 'number', min: 1, max: 1000, step: 1, default: 10 },
      { key: 'hsm', label: 'HSM-protected', type: 'toggle', default: false },
      { key: 'opsM', label: 'Crypto operations / month', type: 'number', min: 0, max: 1000, step: 1, unit: 'M', default: 10 },
    ],
    cost: (c) => num(c, 'keys') * (bool(c, 'hsm') ? 1 : 0.06) + num(c, 'opsM') * 3,
    latency: () => 0,
    ha: () => true,
    chips: (c) => `${num(c, 'keys')} keys${bool(c, 'hsm') ? ' · HSM' : ''}`,
  },
  {
    id: 'fcm',
    name: 'Firebase Cloud Messaging',
    category: 'Messaging & Streaming',
    icon: 'Bell',
    summary: 'Free push delivery to Android, iOS and web clients.',
    tradeoff: 'Free and reliable, but delivery is best-effort: never rely on push for correctness.',
    provides: ['push'],
    fields: [],
    cost: () => 0,
    ha: () => true,
  },

  // ===== Operations ========================================================
  {
    id: 'logging',
    name: 'Cloud Logging',
    category: 'Operations',
    icon: 'FileText',
    summary: 'Centralised, queryable logs with log-based metrics and sinks to BigQuery/GCS.',
    tradeoff: 'Essential for debugging, but ingestion is billed per GiB. Sample noisy logs.',
    provides: ['observability'],
    fields: [{ key: 'gb', label: 'Ingested per month', type: 'number', min: 1, max: 100_000, step: 1, log: true, unit: 'GB', default: 100 }],
    cost: (c) => Math.max(0, num(c, 'gb') - 50) * 0.5,
    ha: () => true,
    chips: (c) => `${compact(num(c, 'gb'))} GB/mo`,
  },
  {
    id: 'monitoring',
    name: 'Cloud Monitoring & Alerting',
    category: 'Operations',
    icon: 'Gauge',
    summary: 'Metrics, dashboards, SLO tracking and paging alerts.',
    tradeoff: 'If you cannot see it, you cannot meet an SLO. High-cardinality custom metrics are the cost trap.',
    provides: ['observability'],
    fields: [{ key: 'metricsMiB', label: 'Custom metrics ingested', type: 'number', min: 1, max: 100_000, step: 1, log: true, unit: 'MiB/mo', default: 150 }],
    cost: (c) => num(c, 'metricsMiB') * 0.258,
    ha: () => true,
    chips: (c) => `${compact(num(c, 'metricsMiB'))} MiB/mo`,
  },
];

export const SERVICE_MAP: Record<string, ServiceDef> = Object.fromEntries(SERVICES.map((s) => [s.id, s]));

// ---- config / cost / capacity wrappers ---------------------------------------

export function defaultConfig(def: ServiceDef): Config {
  const c: Config = {};
  for (const f of def.fields) c[f.key] = f.default;
  return c;
}

export function resolveConfig(def: ServiceDef, cfg: Config | undefined): Config {
  return { ...defaultConfig(def), ...(cfg ?? {}) };
}

export function serviceCost(def: ServiceDef, cfg: Config | undefined, ctx: CostCtx): number {
  const v = def.cost(resolveConfig(def, cfg), ctx);
  return Number.isFinite(v) ? Math.max(0, v) : 0;
}

export function serviceCapacity(def: ServiceDef, cfg: Config | undefined): Capacity {
  return def.capacity ? def.capacity(resolveConfig(def, cfg)) : {};
}

export function serviceLatency(def: ServiceDef, cfg: Config | undefined): number {
  return def.latency ? def.latency(resolveConfig(def, cfg)) : 0;
}

export function serviceHa(def: ServiceDef, cfg: Config | undefined): boolean {
  return def.ha ? def.ha(resolveConfig(def, cfg)) : false;
}

export function serviceMultiRegion(def: ServiceDef, cfg: Config | undefined): boolean {
  return def.multiRegion ? def.multiRegion(resolveConfig(def, cfg)) : false;
}

export function serviceChips(def: ServiceDef, cfg: Config | undefined): string {
  return def.chips ? def.chips(resolveConfig(def, cfg)) : '';
}

export function hasCap(def: ServiceDef, cap: Capability): boolean {
  return def.provides.includes(cap);
}
