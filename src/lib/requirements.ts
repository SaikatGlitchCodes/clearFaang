// Library of reusable rubric requirements. Each problem picks the ones that matter for it.
// A check returns a score in 0..1 plus a human-readable detail; a fix returns a one-click
// design mutation the learner can apply from the results screen.

import type { Capability, Config, Design, Problem, ScoreCategory } from './types';
import type { Analysis } from './analysis';
import type { Graph, GNode } from './graph';
import { STORE_CAPS } from './graph';
import { SERVICE_MAP, serviceCapacity, serviceCost, serviceHa, serviceMultiRegion } from './catalog';
import { ctxFor } from './cost';
import { fmtGB, fmtMs, fmtNum } from './format';
import {
  addNode,
  attachFrom,
  connect,
  frontCompute,
  insertBefore,
  nodesWithCap,
  patchServices,
  pickNode,
  replaceService,
} from './design';
import { autosize, sizeConfig } from './autosize';

export interface Ctx {
  g: Graph;
  a: Analysis;
  p: Problem;
}

export interface CheckResult {
  score: number;
  detail: string;
}

export interface FixDef {
  label: string;
  apply: (d: Design) => Design;
}

export interface ReqDef {
  id: string;
  label: string;
  category: ScoreCategory;
  weight: number;
  why: string;
  check: (x: Ctx) => CheckResult;
  fix?: (x: Ctx) => FixDef | null;
}

// ---- scoring helpers ------------------------------------------------------------

function ratioScore(cap: number, need: number): number {
  if (need <= 0) return 1;
  const r = cap / need;
  if (r >= 1.3) return 1;
  if (r >= 1) return 0.85;
  return Math.max(0, r * 0.8);
}

function capacityDetail(unit: string, cap: number, need: number): string {
  if (need <= 0) return `Nothing to serve here (${fmtNum(cap)} ${unit} provisioned).`;
  const r = cap / need;
  const tag = r >= 1.3 ? 'comfortable headroom' : r >= 1 ? 'tight, add headroom for spikes' : 'under-provisioned';
  return `${fmtNum(cap)} ${unit} capacity vs ${fmtNum(need)} needed (${r.toFixed(1)}x) - ${tag}.`;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
const names = (ns: GNode[]) => ns.map((n) => n.def.name).join(', ');

function feature(cap: Capability, linkWith: Capability[], noun: string) {
  return (x: Ctx): CheckResult => {
    const nodes = x.g.list(cap);
    if (!nodes.length) return { score: 0, detail: `No ${noun} in the design.` };
    const linked = nodes.some((n) => x.g.linkedTo(n, linkWith));
    return linked
      ? { score: 1, detail: `${nodes[0].def.name} is wired in.` }
      : { score: 0.5, detail: `${nodes[0].def.name} is present but not connected to ${linkWith.join(' / ')}.` };
  };
}

// ---- fix helpers -----------------------------------------------------------------

/** Add `serviceId` fed from the first node matching `fromCaps`; if one already exists, just wire it. */
function ensureAttached(
  d: Design,
  serviceIds: string[],
  fromCaps: Capability[],
  config?: Config,
  label?: string,
): Design {
  const from = pickNode(d, fromCaps);
  const existing = d.nodes.find((n) => serviceIds.includes(n.serviceId));
  if (existing) return from ? connect(d, from.id, existing.id) : d;
  return attachFrom(d, serviceIds[0], fromCaps, { config, label }).design;
}

const attach = (
  label: string,
  serviceIds: string[],
  fromCaps: Capability[],
  config?: Config,
): FixDef => ({
  label,
  apply: (d) => ensureAttached(d, serviceIds, fromCaps, config),
});

function firstStore(d: Design) {
  return d.nodes.find((n) => {
    const caps = SERVICE_MAP[n.serviceId]?.provides ?? [];
    return caps.some((c) => c === 'sql' || c === 'nosql' || c === 'wide-column' || c === 'global-db');
  });
}

/** compute -> queue -> worker (-> store). Reuses an existing queue of the same service when present. */
function workerPath(d: Design, queueId: string): Design {
  const front = frontCompute(d);
  let out = d;
  let qid: string;
  const existing = d.nodes.find((n) => n.serviceId === queueId);
  if (existing) {
    qid = existing.id;
    if (front) out = connect(out, front.id, qid);
  } else {
    const q = attachFrom(out, queueId, ['compute']);
    out = q.design;
    qid = q.id;
  }
  const hasConsumer = out.edges.some((e) => {
    const other = e.source === qid ? e.target : e.target === qid ? e.source : null;
    if (!other || (front && other === front.id)) return false;
    const n = out.nodes.find((x) => x.id === other);
    return !!n && (SERVICE_MAP[n.serviceId]?.provides ?? []).includes('compute');
  });
  if (!hasConsumer) {
    const shared = consumerCompute(out);
    if (shared) return connect(out, qid, shared.id);
    const w = addNode(out, 'cloud-run', {
      label: 'Worker',
      config: { share: 30, minInstances: 0, maxInstances: 20 },
    });
    out = connect(w.design, qid, w.id);
    const store = firstStore(out);
    if (store) out = connect(out, w.id, store.id);
  }
  return out;
}

/**
 * Attach a data store. For latency-critical problems the store is fed by an async worker
 * (off the synchronous path) instead of being called inline by the front-line compute.
 */
function attachStore(d: Design, id: string, p: Problem): Design {
  const def = SERVICE_MAP[id];
  const inMemory = !!def && def.provides.includes('cache');
  if (p.scale.latencyMs <= 30 && !inMemory) {
    let out = d;
    let worker = consumerCompute(out);
    if (!worker) {
      out = workerPath(out, 'pubsub');
      worker = consumerCompute(out);
    }
    const existing = out.nodes.find((n) => n.serviceId === id);
    if (existing) return worker ? connect(out, worker.id, existing.id) : out;
    const added = addNode(out, id);
    return worker ? connect(added.design, worker.id, added.id) : added.design;
  }
  return ensureAttached(d, [id], ['compute']);
}

/** The best "good" store for the problem: the first whose capacity can be scaled to the load. */
export function pickStore(p: Problem): string | undefined {
  const good = p.dbFit?.good ?? [];
  if (!good.length) return undefined;
  const s = p.scale;
  const write = s.peakQps * (1 - s.readRatio) * 1.3;
  const read = s.peakQps * s.readRatio * (1 - 0.9 * s.cacheable) * 1.3;
  for (const id of good) {
    const def = SERVICE_MAP[id];
    if (!def) continue;
    const cfg = sizeConfig(id, {}, { readQps: read, writeQps: write, storageGB: s.storageIn === 'db' ? s.storageGB * 1.2 : undefined });
    const cap = serviceCapacity(def, cfg);
    const ok =
      (cap.writeQps === undefined || cap.writeQps >= write) &&
      (cap.readQps === undefined || cap.readQps >= read) &&
      (cap.storageGB === undefined || s.storageIn !== 'db' || cap.storageGB >= s.storageGB);
    if (ok) return id;
  }
  return good[0];
}

function consumerCompute(d: Design) {
  const front = frontCompute(d);
  return nodesWithCap(d, 'compute').find((n) => !front || n.id !== front.id);
}

const MULTI_REGION_PATCHES: [string, Config][] = [
  ['cloud-run', { regions: 2 }],
  ['gke', { regions: 2 }],
  ['gce', { regions: 2 }],
  ['functions', { regions: 2 }],
  ['spanner', { config: 'multi' }],
  ['firestore', { multiRegion: true }],
  ['bigtable', { clusters: 2 }],
  ['cloud-sql', { crossRegion: true }],
  ['alloydb', { crossRegion: true }],
  ['gcs', { location: 'multi' }],
];

const HA_PATCHES: [string, Config][] = [
  ['cloud-sql', { ha: true }],
  ['alloydb', { ha: true }],
  ['bigtable', { clusters: 2 }],
  ['memorystore', { tier: 'standard' }],
  ['memorystore-cluster', { replicas: '1' }],
  ['kafka', { brokers: 3 }],
  ['cloud-run', { minInstances: 2 }],
  ['gce', { instances: 2 }],
  ['gke', { nodes: 3 }],
  ['vertex-ml', { nodes: 2 }],
];

function patchAll(d: Design, patches: [string, Config][]): Design {
  return patches.reduce((acc, [id, patch]) => patchServices(acc, id, patch), d);
}

const autosizeFix = (p: Problem): FixDef => ({
  label: 'Auto-size capacity to the peak load (with 30% headroom)',
  apply: (d) => autosize(d, p).design,
});

// ---- the library -----------------------------------------------------------------

export const REQS: Record<string, ReqDef> = {
  entry: {
    id: 'entry',
    label: 'Complete request path',
    category: 'fit',
    weight: 3,
    why: 'A design needs an entry point (client), something that runs your code, and no dangling boxes.',
    check: ({ g }) => {
      const orphans = g.orphans();
      const compute = g.has('compute');
      const score =
        (g.hasClient ? 0.35 : 0) +
        (compute ? 0.35 : 0) +
        0.3 * (orphans.length === 0 ? 1 : Math.max(0, 1 - orphans.length / Math.max(1, g.nodes.length)));
      const bits: string[] = [];
      if (!g.hasClient) bits.push('no client node');
      if (!compute) bits.push('no compute service');
      if (orphans.length) bits.push(`${orphans.length} unconnected node(s): ${names(orphans)}`);
      return { score, detail: bits.length ? `Problems: ${bits.join('; ')}.` : 'Client reaches compute; every node is connected.' };
    },
    fix: ({ g }) => {
      if (g.hasClient && g.has('compute')) return null;
      return {
        label: 'Add a client and a Cloud Run service and connect them',
        apply: (d) => {
          let out = d;
          let clientId = nodesWithCap(out, 'client')[0]?.id;
          if (!clientId) {
            const c = addNode(out, 'client');
            out = c.design;
            clientId = c.id;
          }
          let compute = nodesWithCap(out, 'compute')[0];
          if (!compute) {
            const r = addNode(out, 'cloud-run');
            out = r.design;
            return connect(out, clientId, r.id);
          }
          return connect(out, clientId, compute.id);
        },
      };
    },
  },

  'compute-capacity': {
    id: 'compute-capacity',
    label: 'Compute covers peak traffic',
    category: 'scalability',
    weight: 4,
    why: 'Front-line compute must absorb peak QPS (after CDN offload) with headroom, or requests queue up and time out.',
    check: ({ g, a }) => {
      if (!g.has('compute')) return { score: 0, detail: 'No compute service to serve requests.' };
      const base = capacityDetail('qps', a.computeCap, a.computeNeed);
      const waste = a.overProvision > 8 ? ' Heavily over-provisioned: you are paying for idle capacity.' : '';
      return { score: ratioScore(a.computeCap, a.computeNeed), detail: base + waste };
    },
    fix: ({ p }) => autosizeFix(p),
  },

  'db-read-capacity': {
    id: 'db-read-capacity',
    label: 'Database handles read load',
    category: 'scalability',
    weight: 3,
    why: 'Reads that miss the cache land on the database. Add replicas, cache, or a store that scales reads horizontally.',
    check: ({ g, a }) => {
      if (!g.stores().length) return { score: 0, detail: 'No database in the design.' };
      return {
        score: ratioScore(a.dbReadCap, a.dbReadNeed),
        detail:
          capacityDetail('reads/s', a.dbReadCap, a.dbReadNeed) +
          (a.cacheLinked ? ` Cache absorbs ~${Math.round(a.cacheHitEff * 100)}% of reads.` : ''),
      };
    },
    fix: ({ p }) => autosizeFix(p),
  },

  'db-write-capacity': {
    id: 'db-write-capacity',
    label: 'Database handles write load',
    category: 'scalability',
    weight: 3,
    why: 'Writes cannot be cached away. A single-writer database caps out; sharded or distributed stores scale writes.',
    check: ({ g, a }) => {
      if (!g.stores().length) return { score: 0, detail: 'No database in the design.' };
      return { score: ratioScore(a.dbWriteCap, a.dbWriteNeed), detail: capacityDetail('writes/s', a.dbWriteCap, a.dbWriteNeed) };
    },
    fix: ({ p }) => autosizeFix(p),
  },

  'storage-capacity': {
    id: 'storage-capacity',
    label: 'Storage fits the dataset',
    category: 'scalability',
    weight: 2.5,
    why: 'Provision where the bulk data lives (object storage for blobs, the database for records) with room to grow.',
    check: ({ a, p }) => {
      const where = { db: 'databases', blob: 'object storage', cache: 'cache memory', any: 'data stores' }[p.scale.storageIn];
      if (a.storageNeed <= 0) return { score: 1, detail: 'No storage requirement.' };
      const r = a.storageCap / a.storageNeed;
      const score = r >= 1 ? 1 : Math.max(0, r * 0.8);
      return { score, detail: `${fmtGB(a.storageCap)} in ${where} vs ${fmtGB(a.storageNeed)} needed.` };
    },
    fix: ({ p }) => autosizeFix(p),
  },

  'cache-capacity': {
    id: 'cache-capacity',
    label: 'Cache tier handles the throughput',
    category: 'scalability',
    weight: 4,
    why: 'When the hot path lives in memory, the cache tier itself must be sharded to the required ops/s.',
    check: ({ g, a }) => {
      if (!g.has('cache')) return { score: 0, detail: 'No cache in the design.' };
      return { score: ratioScore(a.cacheCap, a.cacheNeed), detail: capacityDetail('ops/s', a.cacheCap, a.cacheNeed) };
    },
    fix: ({ g, p }) => {
      if (!g.has('cache')) {
        return attach(
          p.scale.peakQps > 80_000 ? 'Add Memorystore Cluster (sharded Redis)' : 'Add Memorystore (Redis)',
          [p.scale.peakQps > 80_000 ? 'memorystore-cluster' : 'memorystore'],
          ['compute'],
        );
      }
      return autosizeFix(p);
    },
  },

  'stream-capacity': {
    id: 'stream-capacity',
    label: 'Streaming backbone handles the message rate',
    category: 'scalability',
    weight: 4,
    why: 'Brokers (or partitions) must be sized for the peak produce rate, with replication overhead.',
    check: ({ g, a, p }) => {
      const streams = g.list('stream');
      if (!streams.length) return { score: 0, detail: 'No partitioned log (Managed Kafka) in the design.' };
      const cap = sum(streams.map((n) => serviceCapacity(n.def, n.cfg).qps ?? 0));
      const need = Math.max(1, a.originPeak * (1 - p.scale.readRatio));
      return { score: ratioScore(cap, need), detail: capacityDetail('msgs/s', cap, need) };
    },
    fix: ({ g, p }) =>
      g.has('stream') ? autosizeFix(p) : { label: 'Add Managed Kafka with a consumer', apply: (d) => workerPath(d, 'kafka') },
  },

  'db-fit': {
    id: 'db-fit',
    label: 'Right database for the access pattern',
    category: 'fit',
    weight: 4,
    why: 'Pick the store whose strengths match the workload: key-value lookups, relational transactions, wide-column writes, or analytics.',
    check: ({ g, p }) => {
      const fit = p.dbFit;
      if (!fit) return { score: 1, detail: 'No specific database constraint for this problem.' };
      const present = g.nodes.filter((n) => g.reachable.has(n.id)).map((n) => n.def.id);
      const pick = (ids: string[]) => ids.filter((id) => present.includes(id));
      const good = pick(fit.good);
      const ok = pick(fit.ok);
      const bad = pick(fit.bad);
      const nm = (ids: string[]) => ids.map((id) => SERVICE_MAP[id]?.name ?? id).join(', ');
      if (good.length) return { score: 1, detail: `${nm(good)}: strong fit. ${fit.note}` };
      if (ok.length) return { score: 0.6, detail: `${nm(ok)}: workable but not ideal. ${fit.note}` };
      if (bad.length) return { score: 0.15, detail: `${nm(bad)}: poor fit for this workload. ${fit.note}` };
      return { score: 0, detail: `No suitable primary store. ${fit.note}` };
    },
    fix: ({ p }) => {
      const id = pickStore(p);
      if (!id) return null;
      const name = SERVICE_MAP[id]?.name ?? id;
      return { label: `Add ${name} as the primary store`, apply: (d) => attachStore(d, id, p) };
    },
  },

  lb: {
    id: 'lb',
    label: 'Load balancer in front of compute',
    category: 'reliability',
    weight: 2,
    why: 'A load balancer spreads traffic, health-checks instances and removes the single point of failure at the front door.',
    check: ({ g }) => {
      const lbs = g.list('lb');
      if (!lbs.length) return { score: 0, detail: 'No load balancer.' };
      const toCompute = lbs.some((n) => g.linkedTo(n, 'compute'));
      const fromEdge = lbs.some((n) => g.linkedTo(n, ['client', 'cdn', 'waf', 'apigw', 'dns']));
      if (toCompute && fromEdge) return { score: 1, detail: 'Traffic flows edge -> load balancer -> compute.' };
      if (toCompute) return { score: 0.7, detail: 'Load balancer reaches compute, but nothing routes users to it.' };
      return { score: 0.4, detail: 'Load balancer is not connected to compute.' };
    },
    fix: () => ({
      label: 'Put Cloud Load Balancing in front of compute',
      apply: (d) => {
        const existing = d.nodes.find((n) => n.serviceId === 'lb');
        if (existing) {
          const c = frontCompute(d);
          const client = nodesWithCap(d, 'client')[0];
          let out = d;
          if (c) out = connect(out, existing.id, c.id);
          if (client) out = connect(out, client.id, existing.id);
          return out;
        }
        return insertBefore(d, 'lb', ['compute'], ['apigw', 'waf', 'cdn', 'client']);
      },
    }),
  },

  'cache-read': {
    id: 'cache-read',
    label: 'In-memory cache for hot reads',
    category: 'performance',
    weight: 3,
    why: 'Caching hot keys cuts latency from milliseconds to sub-millisecond and shields the database from read spikes.',
    check: ({ g, a, p }) => {
      const caches = g.list('cache');
      if (!caches.length) return { score: 0, detail: 'No cache. Every read hits the database.' };
      if (!a.cacheLinked) return { score: 0.5, detail: 'A cache exists but compute is not connected to it.' };
      const hit = Math.max(...caches.map((c) => Number(c.cfg.hitRatio)));
      const eff = Math.round(a.cacheHitEff * 100);
      const score = p.scale.cacheable < 0.2 ? 0.6 : hit >= 70 ? 1 : 0.8;
      return { score, detail: `Cache expected to absorb ~${eff}% of reads (hit ratio ${hit}% x ${Math.round(p.scale.cacheable * 100)}% cacheable).` };
    },
    fix: ({ p }) =>
      attach(
        p.scale.peakQps > 80_000 ? 'Add Memorystore Cluster as a read cache' : 'Add Memorystore (Redis) as a read cache',
        [p.scale.peakQps > 80_000 ? 'memorystore-cluster' : 'memorystore'],
        ['compute'],
      ),
  },

  cdn: {
    id: 'cdn',
    label: 'CDN for cacheable content',
    category: 'performance',
    weight: 3,
    why: 'Serving cacheable bytes from the edge cuts latency, origin load and egress cost.',
    check: ({ g, a }) => {
      const cdns = g.list('cdn');
      if (!cdns.length) return { score: 0, detail: 'No CDN. Every byte is served from the origin.' };
      const linked = cdns.some((n) => g.linkedTo(n, ['lb', 'compute', 'blob', 'client', 'waf']));
      if (!linked) return { score: 0.5, detail: 'CDN is present but not connected to the path.' };
      return { score: 1, detail: `CDN offloads ~${Math.round(a.cdnOffload * 100)}% of peak traffic from the origin.` };
    },
    fix: ({ p }) => ({
      label: p.scale.payloadKB >= 500 ? 'Add Media CDN in front of the origin' : 'Add Cloud CDN in front of the origin',
      apply: (d) => {
        const id = p.scale.payloadKB >= 500 ? 'media-cdn' : 'cdn';
        const existing = d.nodes.find((n) => n.serviceId === 'cdn' || n.serviceId === 'media-cdn');
        if (existing) {
          const client = nodesWithCap(d, 'client')[0];
          const target = pickNode(d, ['waf', 'apigw', 'lb', 'compute']);
          let out = d;
          if (client) out = connect(out, client.id, existing.id);
          if (target) out = connect(out, existing.id, target.id);
          return out;
        }
        return insertBefore(d, id, ['waf', 'apigw', 'lb', 'compute'], ['client']);
      },
    }),
  },

  blob: {
    id: 'blob',
    label: 'Object storage for large blobs',
    category: 'fit',
    weight: 3,
    why: 'Big immutable payloads (files, images, video) belong in object storage, with only metadata in the database.',
    check: feature('blob', ['compute', 'cdn', 'transcode', 'queue'], 'Cloud Storage bucket'),
    fix: ({ p }) => ({
      label: 'Add a Cloud Storage bucket',
      apply: (d) => {
        // Bulk object storage sees much of the traffic; archive / tiering buckets only a sliver.
        let out = ensureAttached(d, ['gcs'], ['compute'], { share: p.scale.storageIn === 'blob' ? 30 : 2 });
        const gcs = out.nodes.find((n) => n.serviceId === 'gcs');
        const cdn = nodesWithCap(out, 'cdn')[0];
        if (gcs && cdn) out = connect(out, cdn.id, gcs.id);
        return out;
      },
    }),
  },

  'async-queue': {
    id: 'async-queue',
    label: 'Async hand-off with a queue and workers',
    category: 'reliability',
    weight: 3,
    why: 'Queues decouple producers from slow or bursty consumers, absorb spikes and let you retry safely (idempotent consumers).',
    check: ({ g, p }) => {
      const qs = g.list('queue');
      if (!qs.length) return { score: 0, detail: 'No queue. Slow work happens inline and spikes hit the database directly.' };
      let best = 0;
      for (const q of qs) {
        const links = g.neighbors(q).filter((n) => g.is(n, ['compute', 'stream-processing', 'workflow']));
        best = Math.max(best, links.length >= 2 ? 1 : links.length === 1 ? 0.5 : 0);
      }
      let score = best;
      let detail =
        best === 1
          ? 'Producer -> queue -> consumer pattern is present.'
          : best === 0.5
            ? 'A queue is connected to only one compute node: add a separate worker/consumer.'
            : 'A queue exists but is not connected to compute.';
      const limited = qs.map((q) => serviceCapacity(q.def, q.cfg).qps).filter((v): v is number => v !== undefined);
      if (limited.length === qs.length) {
        const cap = sum(limited);
        const need = p.scale.peakQps * (1 - p.scale.readRatio);
        if (cap < need) {
          score *= 0.7;
          detail += ` Queue dispatch capacity ${fmtNum(cap)}/s is below the ~${fmtNum(need)}/s write path.`;
        }
      }
      return { score, detail };
    },
    fix: () => ({ label: 'Add Pub/Sub with a worker service', apply: (d) => workerPath(d, 'pubsub') }),
  },

  stream: {
    id: 'stream',
    label: 'Partitioned, replayable log',
    category: 'scalability',
    weight: 3,
    why: 'Ordered, partitioned logs let you replay history, add consumers and scale throughput by partition.',
    check: ({ g }) => {
      if (g.has('stream')) return { score: 1, detail: 'Managed Kafka provides ordered partitions and replay.' };
      const qs = g.list('queue');
      if (qs.some((q) => q.def.id === 'pubsub'))
        return { score: 0.6, detail: 'Pub/Sub scales well but gives per-key ordering only and no partition control.' };
      if (qs.length) return { score: 0.3, detail: 'A task queue is not a replayable log.' };
      return { score: 0, detail: 'No streaming backbone.' };
    },
    fix: () => ({ label: 'Add Managed Kafka with a consumer', apply: (d) => workerPath(d, 'kafka') }),
  },

  'sql-acid': {
    id: 'sql-acid',
    label: 'Transactional (ACID) store for critical state',
    category: 'fit',
    weight: 3,
    why: 'Bookings, balances and inventory need atomic updates and isolation to avoid double-spend and overselling.',
    check: ({ g }) => {
      const sql = g.list('sql').filter((n) => g.linkedTo(n, 'compute'));
      if (sql.length) return { score: 1, detail: `${names(sql)} gives ACID transactions.` };
      const fs = g.list('nosql').filter((n) => n.def.id === 'firestore' && g.linkedTo(n, 'compute'));
      if (fs.length) return { score: 0.6, detail: 'Firestore transactions work but limit query shapes and per-document write rates.' };
      return { score: 0, detail: 'No relational / transactional store connected to compute.' };
    },
    fix: ({ p }) => {
      const id = p.dbFit?.good.find((x) => ['cloud-sql', 'alloydb', 'spanner'].includes(x)) ?? 'cloud-sql';
      return { label: `Add ${SERVICE_MAP[id].name} for transactional state`, apply: (d) => attachStore(d, id, p) };
    },
  },

  'strong-global': {
    id: 'strong-global',
    label: 'Strongly consistent across regions',
    category: 'reliability',
    weight: 3,
    why: 'Money and locks cannot be eventually consistent. Multi-region strong consistency means consensus replication (Spanner).',
    check: ({ g }) => {
      const sp = g.list('global-db');
      if (sp.some((n) => serviceMultiRegion(n.def, n.cfg)))
        return { score: 1, detail: 'Spanner multi-region replicates synchronously with externally consistent transactions.' };
      if (sp.length) return { score: 0.4, detail: 'Spanner is regional: consistent, but a region outage takes you down.' };
      const fs = g.list('nosql').find((n) => n.def.id === 'firestore' && serviceMultiRegion(n.def, n.cfg));
      if (fs) return { score: 0.6, detail: 'Firestore multi-region is strongly consistent but not relational.' };
      if (g.stores().some((n) => serviceMultiRegion(n.def, n.cfg)))
        return { score: 0.3, detail: 'Cross-region replicas are asynchronous: failover can lose recent writes.' };
      return { score: 0, detail: 'No multi-region strongly consistent store.' };
    },
    fix: () => ({
      label: 'Use Cloud Spanner in a multi-region configuration',
      apply: (d) => {
        const sp = d.nodes.find((n) => n.serviceId === 'spanner');
        if (sp) return patchServices(d, 'spanner', { config: 'multi' });
        return attachFrom(d, 'spanner', ['compute'], { config: { config: 'multi' } }).design;
      },
    }),
  },

  'multi-region': {
    id: 'multi-region',
    label: 'Survives a regional outage',
    category: 'reliability',
    weight: 3,
    why: 'Region-level failures happen. Compute, data and the edge all need a second region to keep serving.',
    check: ({ g, p }) => {
      const compute = g.list('compute', 'sync').some((n) => serviceMultiRegion(n.def, n.cfg));
      const stores = g.stores();
      const dataMulti =
        g.list([...STORE_CAPS, 'blob']).some((n) => serviceMultiRegion(n.def, n.cfg)) ||
        (!stores.length && p.scale.cacheFirst && g.has(['queue', 'stream']));
      const edge = g.has(['lb', 'cdn']);
      const score = (compute ? 0.4 : 0) + (dataMulti ? 0.4 : 0) + (edge ? 0.2 : 0);
      const missing: string[] = [];
      if (!compute) missing.push('compute is single-region');
      if (!dataMulti) missing.push('data tier is single-region');
      if (!edge) missing.push('no global load balancer / CDN');
      return { score, detail: missing.length ? `Gaps: ${missing.join('; ')}.` : 'Compute, data and edge are all multi-region.' };
    },
    fix: () => ({
      label: 'Deploy compute and data across 2 regions',
      apply: (d) => {
        const out = patchAll(d, MULTI_REGION_PATCHES);
        return nodesWithCap(out, 'lb').length ? out : insertBefore(out, 'lb', ['compute'], ['apigw', 'waf', 'cdn', 'client']);
      },
    }),
  },

  'ha-db': {
    id: 'ha-db',
    label: 'Databases survive a zone failure',
    category: 'reliability',
    weight: 3,
    why: 'Single-zone databases are the classic outage. Use HA standbys, regional configs or replicated clusters.',
    check: ({ g }) => {
      const stores = g.stores();
      if (!stores.length) return { score: 0, detail: 'No database in the design.' };
      const scores = stores.map((n) => (serviceHa(n.def, n.cfg) ? 1 : 0.2));
      const weak = stores.filter((n) => !serviceHa(n.def, n.cfg));
      return {
        score: mean(scores),
        detail: weak.length ? `Not highly available: ${names(weak)}.` : 'All data stores are highly available.',
      };
    },
    fix: () => ({ label: 'Enable HA / replication on data stores', apply: (d) => patchAll(d, HA_PATCHES.slice(0, 3)) }),
  },

  'ha-compute': {
    id: 'ha-compute',
    label: 'Compute survives instance failures',
    category: 'reliability',
    weight: 2,
    why: 'At least two instances across zones so one failure or deploy does not cause downtime.',
    check: ({ g }) => {
      let compute = g.list('compute', 'sync');
      if (!compute.length) compute = g.list('compute');
      if (!compute.length) return { score: 0, detail: 'No compute service.' };
      const ok = compute.filter((n) => serviceHa(n.def, n.cfg));
      return {
        score: ok.length / compute.length,
        detail: ok.length === compute.length ? 'Compute runs on multiple instances/zones.' : 'Some compute runs a single instance.',
      };
    },
    fix: () => ({ label: 'Run at least 2 instances of each compute service', apply: (d) => patchAll(d, HA_PATCHES.slice(6)) }),
  },

  'ha-cache': {
    id: 'ha-cache',
    label: 'Cache has replicas and failover',
    category: 'reliability',
    weight: 3,
    why: 'When the cache is on the hot path, losing a node must not lose the traffic: use replicas and automatic failover.',
    check: ({ g }) => {
      const caches = g.list('cache');
      if (!caches.length) return { score: 0, detail: 'No cache in the design.' };
      const score = mean(caches.map((n) => (serviceHa(n.def, n.cfg) ? 1 : 0.25)));
      return { score, detail: score === 1 ? 'Cache nodes have replicas / automatic failover.' : 'Cache runs without replicas (Basic tier or 0 replicas).' };
    },
    fix: () => ({ label: 'Use replicas / Standard tier for the cache', apply: (d) => patchAll(d, HA_PATCHES.slice(3, 5)) }),
  },

  'ha-stream': {
    id: 'ha-stream',
    label: 'Messaging backbone is replicated',
    category: 'reliability',
    weight: 2,
    why: 'A log or queue that loses a broker loses messages. Replicate across at least 3 brokers/zones.',
    check: ({ g }) => {
      const m = g.list(['queue', 'stream']);
      if (!m.length) return { score: 0, detail: 'No messaging layer.' };
      const score = mean(m.map((n) => (serviceHa(n.def, n.cfg) ? 1 : 0.3)));
      return { score, detail: score === 1 ? 'Messaging layer is replicated.' : 'A broker cluster has fewer than 3 brokers.' };
    },
    fix: () => ({ label: 'Run Kafka with at least 3 brokers', apply: (d) => patchServices(d, 'kafka', { brokers: 3 }) }),
  },

  waf: {
    id: 'waf',
    label: 'WAF / DDoS protection at the edge',
    category: 'fit',
    weight: 2,
    why: 'Block bots, floods and common exploits before they cost you compute.',
    check: ({ g }) => {
      const w = g.list('waf');
      if (!w.length) return { score: 0, detail: 'No WAF.' };
      return g.linkedTo(w[0], ['lb', 'client', 'apigw', 'cdn', 'compute'])
        ? { score: 1, detail: 'Cloud Armor sits on the request path.' }
        : { score: 0.5, detail: 'Cloud Armor is present but not on the request path.' };
    },
    fix: () => ({
      label: 'Add Cloud Armor in front of the load balancer',
      apply: (d) => {
        const existing = d.nodes.find((n) => n.serviceId === 'armor');
        if (existing) {
          const target = pickNode(d, ['apigw', 'lb', 'compute']);
          const client = nodesWithCap(d, 'client')[0];
          let out = d;
          if (client) out = connect(out, client.id, existing.id);
          if (target) out = connect(out, existing.id, target.id);
          return out;
        }
        return insertBefore(d, 'armor', ['apigw', 'lb', 'compute'], ['cdn', 'client']);
      },
    }),
  },

  ratelimit: {
    id: 'ratelimit',
    label: 'Rate limiting / quotas',
    category: 'fit',
    weight: 2,
    why: 'Protect shared resources from abusive or buggy clients with per-key or per-IP limits.',
    check: ({ g }) => {
      if (g.has('ratelimit')) return { score: 1, detail: 'Cloud Armor or API Gateway enforces limits at the edge.' };
      if (g.list('cache').some((c) => g.linkedTo(c, 'compute')))
        return { score: 0.6, detail: 'A Redis-backed limiter works but costs compute on every request; add an edge limit too.' };
      return { score: 0, detail: 'No rate limiting.' };
    },
    fix: ({ g }) =>
      g.has('waf')
        ? {
            label: 'Add API Gateway for per-consumer quotas',
            apply: (d) => insertBefore(d, 'apigw', ['lb', 'compute'], ['waf', 'cdn', 'client']),
          }
        : {
            label: 'Add Cloud Armor with rate-limit rules',
            apply: (d) => insertBefore(d, 'armor', ['apigw', 'lb', 'compute'], ['cdn', 'client']),
          },
  },

  auth: {
    id: 'auth',
    label: 'Managed authentication',
    category: 'fit',
    weight: 2,
    why: 'Delegate sign-in, MFA and token issuing to a managed identity service instead of rolling your own.',
    check: ({ g }) => {
      const a = g.list('auth');
      if (!a.length) return { score: 0, detail: 'No authentication service.' };
      return g.linkedTo(a[0], ['compute', 'apigw', 'client', 'lb'])
        ? { score: 1, detail: 'Identity Platform issues and verifies tokens.' }
        : { score: 0.6, detail: 'Identity Platform is present but not connected.' };
    },
    fix: () => attach('Add Identity Platform', ['identity'], ['compute']),
  },

  secrets: {
    id: 'secrets',
    label: 'Secrets and keys are managed',
    category: 'fit',
    weight: 2,
    why: 'Keys and credentials belong in Secret Manager / KMS with IAM and audit trails, never in images or code.',
    check: ({ g }) => {
      const s = g.list('secrets');
      if (!s.length) return { score: 0, detail: 'No secret or key management.' };
      return s.some((n) => g.linkedTo(n, 'compute'))
        ? { score: 1, detail: `${names(s)} is wired to compute.` }
        : { score: 0.5, detail: `${names(s)} is present but not connected to compute.` };
    },
    fix: ({ p }) =>
      p.tags.includes('Security')
        ? attach('Add Cloud KMS (HSM-grade key custody)', ['kms'], ['compute'])
        : attach('Add Secret Manager', ['secret-manager'], ['compute']),
  },

  observability: {
    id: 'observability',
    label: 'Logging and monitoring',
    category: 'reliability',
    weight: 1.5,
    why: 'You cannot meet an SLO you cannot see: structured logs, dashboards and paging alerts.',
    check: ({ g }) => {
      const log = g.list('observability').some((n) => n.def.id === 'logging');
      const mon = g.list('observability').some((n) => n.def.id === 'monitoring');
      const score = (log ? 0.5 : 0) + (mon ? 0.5 : 0);
      return {
        score,
        detail: log && mon ? 'Logging and monitoring are present.' : `Missing: ${[!log ? 'Cloud Logging' : '', !mon ? 'Cloud Monitoring' : ''].filter(Boolean).join(', ')}.`,
      };
    },
    fix: () => ({
      label: 'Add Cloud Logging and Cloud Monitoring',
      apply: (d) => ensureAttached(ensureAttached(d, ['logging'], ['compute']), ['monitoring'], ['compute']),
    }),
  },

  search: {
    id: 'search',
    label: 'Dedicated search',
    category: 'performance',
    weight: 2.5,
    why: 'Relevance ranking, typo tolerance and facets need a search engine, not SQL LIKE queries.',
    check: (x) => {
      const base = feature('search', ['compute'], 'search service')(x);
      const nodes = x.g.list('search');
      if (!nodes.length) return base;
      const caps = nodes.map((n) => serviceCapacity(n.def, n.cfg).qps).filter((v): v is number => v !== undefined);
      if (!caps.length) return base;
      const need = x.a.originPeak * (Number(nodes[0].cfg.share ?? 5) / 100);
      const cap = sum(caps);
      if (cap >= need) return base;
      return { score: base.score * Math.max(0.3, cap / need), detail: `${base.detail} Search capacity ${fmtNum(cap)} qps is below the ~${fmtNum(need)} qps load.` };
    },
    fix: ({ p }) => {
      // Buy-vs-build: per-query pricing wins at low QPS, flat node pricing at high QPS.
      const ctx = ctxFor(p);
      const buy = serviceCost(SERVICE_MAP['vertex-search'], undefined, ctx);
      const build = serviceCost(SERVICE_MAP['elasticsearch'], undefined, ctx);
      const id = build < buy ? 'elasticsearch' : 'vertex-search';
      return attach(`Add ${SERVICE_MAP[id].name} (cheaper at this query volume)`, [id], ['compute']);
    },
  },

  push: {
    id: 'push',
    label: 'Push notifications',
    category: 'fit',
    weight: 2,
    why: 'Reach offline or backgrounded devices through the platform push channels.',
    check: feature('push', ['compute', 'queue', 'workflow'], 'push channel'),
    fix: () => attach('Add Firebase Cloud Messaging', ['fcm'], ['compute']),
  },

  geo: {
    id: 'geo',
    label: 'Maps / routing',
    category: 'fit',
    weight: 2.5,
    why: 'Distance, ETA and geocoding are best bought, then cached, not built.',
    check: feature('geo', ['compute'], 'maps / routing service'),
    fix: () => attach('Add Maps Platform', ['maps'], ['compute']),
  },

  transcode: {
    id: 'transcode',
    label: 'Video transcoding pipeline',
    category: 'fit',
    weight: 2.5,
    why: 'Adaptive-bitrate playback requires transcoding uploads into a ladder of renditions.',
    check: feature('transcode', ['blob', 'queue', 'compute', 'workflow'], 'transcoder'),
    fix: () => attach('Add Transcoder API', ['transcoder'], ['blob', 'compute']),
  },

  ml: {
    id: 'ml',
    label: 'Model serving',
    category: 'fit',
    weight: 2,
    why: 'Ranking, ETA, pricing and fraud decisions come from a served model.',
    check: feature('ml', ['compute'], 'model-serving endpoint'),
    fix: () => attach('Add Vertex AI Prediction', ['vertex-ml'], ['compute']),
  },

  workflow: {
    id: 'workflow',
    label: 'Orchestrated multi-step flow (saga)',
    category: 'fit',
    weight: 3,
    why: 'Multi-service business flows (reserve, charge, confirm) need explicit orchestration with retries and compensation.',
    check: feature('workflow', ['compute', 'queue'], 'workflow orchestrator'),
    fix: () => attach('Add Workflows', ['workflows'], ['compute']),
  },

  scheduler: {
    id: 'scheduler',
    label: 'Scheduled jobs',
    category: 'fit',
    weight: 1.5,
    why: 'Expiry, reminders, reconciliation and cleanups run on a schedule.',
    check: feature('scheduler', ['compute', 'queue', 'workflow'], 'scheduler'),
    fix: () => attach('Add Cloud Scheduler', ['scheduler'], ['compute']),
  },

  analytics: {
    id: 'analytics',
    label: 'Analytics warehouse',
    category: 'fit',
    weight: 2,
    why: 'Reporting, reconciliation and ML features belong in a warehouse, not your OLTP store.',
    check: feature('analytics', ['queue', 'stream', 'stream-processing', 'compute', 'blob'], 'analytics warehouse'),
    fix: () => attach('Add BigQuery', ['bigquery'], ['stream-processing', 'queue', 'compute']),
  },

  'stream-processing': {
    id: 'stream-processing',
    label: 'Stream / batch processing',
    category: 'scalability',
    weight: 2.5,
    why: 'Windowed aggregation, enrichment and indexing over a firehose need a processing engine such as Dataflow.',
    check: feature('stream-processing', ['queue', 'stream'], 'stream-processing engine'),
    fix: () => attach('Add Dataflow', ['dataflow'], ['stream', 'queue', 'compute']),
  },

  'external-isolated': {
    id: 'external-isolated',
    label: 'Third-party calls isolated behind async workers',
    category: 'reliability',
    weight: 3,
    why: 'Vendors are slow and flaky. Call them from workers with retries and backoff, never inline in the request path.',
    check: ({ g }) => {
      const ext = g.list('external');
      if (!ext.length) return { score: 0, detail: 'No third-party provider modelled (payment gateway, SMS, email...).' };
      const scores = ext.map((e) => {
        const neighbors = g.neighbors(e);
        const isolated = neighbors.some((n) => g.is(n, 'workflow') || (g.is(n, 'compute') && !g.sync.has(n.id)));
        return isolated ? 1 : 0.3;
      });
      const score = mean(scores);
      return {
        score,
        detail: score === 1 ? 'Provider calls happen from async workers.' : 'A provider is called straight from the synchronous request path.',
      };
    },
    fix: () => ({
      label: 'Call the provider from a queue-backed worker',
      apply: (d) => {
        let out = d;
        let worker = consumerCompute(out);
        if (!worker) {
          out = workerPath(out, 'pubsub');
          worker = consumerCompute(out);
        }
        const ext = out.nodes.find((n) => n.serviceId === 'external');
        if (ext) {
          // detach from front compute, attach to worker
          const front = frontCompute(out);
          if (front) out = { ...out, edges: out.edges.filter((e) => !((e.source === front.id && e.target === ext.id) || (e.source === ext.id && e.target === front.id))) };
          return worker ? connect(out, worker.id, ext.id) : out;
        }
        const added = addNode(out, 'external');
        return worker ? connect(added.design, worker.id, added.id) : added.design;
      },
    }),
  },

  'latency-budget': {
    id: 'latency-budget',
    label: 'Meets the latency budget',
    category: 'performance',
    weight: 4,
    why: 'Each hop adds latency. Count the synchronous path and keep slow dependencies off it.',
    check: ({ a, p }) => {
      const budget = p.scale.latencyMs;
      const ratio = a.latencyMs / budget;
      const score = ratio <= 1 ? 1 : ratio <= 1.5 ? 0.6 : ratio <= 2.5 ? 0.3 : 0;
      const parts = a.latencyParts.map((x) => `${x.label} ${fmtMs(x.ms)}`).join(' + ');
      return {
        score,
        detail: `Estimated p95 ${fmtMs(a.latencyMs)} vs ${fmtMs(budget)} budget${parts ? ` (${parts})` : ''}.`,
      };
    },
    fix: ({ g, a, p }) => {
      if (a.latencyMs <= p.scale.latencyMs) return null;
      if (!g.has('cache') && p.scale.cacheable > 0)
        return attach('Add a Redis cache to skip the database on hits', ['memorystore'], ['compute']);
      const slow = g.list('compute', 'sync').find((n) => n.def.id === 'cloud-run' || n.def.id === 'functions');
      if (slow && p.scale.latencyMs < 30)
        return {
          label: 'Move the hot path from serverless to Compute Engine',
          apply: (d) => replaceService(d, slow.id, 'gce', { instances: 3, machine: '8' }),
        };
      return null;
    },
  },

  'no-serverless': {
    id: 'no-serverless',
    label: 'Dedicated compute on the hot path',
    category: 'performance',
    weight: 3,
    why: 'Serverless adds cold starts and noisy-neighbour jitter. Latency-critical engines run on pinned VMs or nodes.',
    check: ({ g }) => {
      const c = g.list('compute', 'sync');
      if (!c.length) return { score: 0, detail: 'No compute service.' };
      const dedicated = c.filter((n) => n.def.id === 'gce' || n.def.id === 'gke');
      return {
        score: dedicated.length / c.length,
        detail: dedicated.length === c.length ? 'Hot path runs on dedicated VMs/nodes.' : 'Serverless compute (Cloud Run / Functions) is on the hot path.',
      };
    },
    fix: () => ({
      label: 'Replace serverless hot-path compute with Compute Engine',
      apply: (d) =>
        d.nodes
          .filter((n) => n.serviceId === 'cloud-run' || n.serviceId === 'functions')
          .reduce((acc, n) => replaceService(acc, n.id, 'gce', { instances: 3, machine: '8' }), d),
    }),
  },

  'min-nodes': {
    id: 'min-nodes',
    label: 'Enough independent nodes',
    category: 'reliability',
    weight: 3,
    why: 'Byzantine fault tolerance needs 3f+1 nodes. Spread at least 7 across regions to tolerate 2 faulty ones.',
    check: ({ g }) => {
      const nodes = sum(
        g
          .list('compute')
          .map((n) => (n.def.id === 'gce' ? Number(n.cfg.instances) * Number(n.cfg.regions) : n.def.id === 'gke' ? Number(n.cfg.nodes) * Number(n.cfg.regions) : 0)),
      );
      return { score: Math.min(1, nodes / 7), detail: `${nodes} VM/node(s) provisioned; target is 7 or more.` };
    },
    fix: () => ({
      label: 'Run validator nodes on Compute Engine across 3 regions',
      apply: (d) => {
        const gce = d.nodes.find((n) => n.serviceId === 'gce');
        if (gce) return patchServices(d, 'gce', { instances: 3, regions: 3 });
        const c = frontCompute(d);
        return c ? replaceService(d, c.id, 'gce', { instances: 3, regions: 3 }) : d;
      },
    }),
  },

  dns: {
    id: 'dns',
    label: 'DNS routing',
    category: 'performance',
    weight: 1.5,
    why: 'Geo / latency-based DNS steers users to the nearest healthy region.',
    check: ({ g }) => (g.has('dns') ? { score: 1, detail: 'Cloud DNS is in place.' } : { score: 0, detail: 'No DNS service.' }),
    fix: () => ({
      label: 'Add Cloud DNS',
      apply: (d) => {
        const client = nodesWithCap(d, 'client')[0];
        const added = addNode(d, 'dns');
        return client ? connect(added.design, client.id, added.id) : added.design;
      },
    }),
  },
};

export const REQ_IDS = Object.keys(REQS);
