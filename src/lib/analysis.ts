// Turns a Design + Problem into measurable numbers: load after offload, capacity, latency, cost.

import type { Design, Problem } from './types';
import { serviceCapacity, serviceLatency } from './catalog';
import { Graph, STORE_CAPS, cacheHitEffOf } from './graph';
import type { GNode } from './graph';
import { computeCost } from './cost';
import type { CostResult } from './cost';

export interface Analysis {
  g: Graph;
  cost: CostResult;
  /** Peak QPS that actually reaches the origin after CDN offload. */
  originPeak: number;
  cdnOffload: number;
  cacheLinked: boolean;
  /** Effective share of reads served from cache (cache hit ratio x cacheable fraction). */
  cacheHitEff: number;
  computeCap: number;
  computeNeed: number;
  dbReadCap: number;
  dbReadNeed: number;
  dbWriteCap: number;
  dbWriteNeed: number;
  storageCap: number;
  storageNeed: number;
  cacheCap: number;
  cacheNeed: number;
  latencyMs: number;
  latencyParts: { label: string; ms: number }[];
  /** compute capacity / compute need (>1 means headroom). */
  overProvision: number;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const maxOf = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);

export function analyze(design: Design, p: Problem): Analysis {
  const g = new Graph(design);
  const s = p.scale;
  const cost = computeCost(design, p);

  // ---- CDN offload
  const cdnNodes = g.list('cdn').filter((n) => g.neighbors(n).length > 0);
  const cdnOffload = cdnNodes.length
    ? maxOf(cdnNodes.map((n) => s.cdnFriendly * (Number(n.cfg.share) / 100) * (Number(n.cfg.hitRatio) / 100)))
    : 0;
  const originPeak = s.peakQps * (1 - cdnOffload);

  // ---- cache effect on the database
  const linkedCaches = g.list('cache').filter((c) => g.linkedTo(c, 'compute'));
  const cacheLinked = linkedCaches.length > 0;
  const cacheHitEff = cacheHitEffOf(g, s.cacheable);

  // ---- compute capacity (front-line compute only: the nodes serving user traffic)
  let compute = g.list('compute', 'sync');
  if (!compute.length) compute = g.list('compute');
  const computeCap = sum(compute.map((n) => serviceCapacity(n.def, n.cfg).qps ?? 0));
  const computeNeed = originPeak / (s.computeFactor ?? 1);

  // ---- data stores
  const stores = g.stores();
  const dbReadCap = sum(stores.map((n) => serviceCapacity(n.def, n.cfg).readQps ?? 0));
  const dbWriteCap = sum(stores.map((n) => serviceCapacity(n.def, n.cfg).writeQps ?? 0));
  const dbReadNeed = originPeak * s.readRatio * (1 - cacheHitEff);
  const dbWriteNeed = originPeak * (1 - s.readRatio);

  // ---- storage
  const caps = (nodes: GNode[]) => sum(nodes.map((n) => serviceCapacity(n.def, n.cfg).storageGB ?? 0));
  let storageCap = 0;
  if (s.storageIn === 'db') storageCap = caps(stores);
  else if (s.storageIn === 'blob') storageCap = caps(g.list('blob'));
  else if (s.storageIn === 'cache') storageCap = caps(g.list('cache'));
  else storageCap = caps(stores) + caps(g.list('blob')) + caps(g.list('analytics')) + caps(g.list('stream'));
  const storageNeed = s.storageGB;

  // ---- cache throughput
  const cacheCap = sum(g.list('cache').map((n) => serviceCapacity(n.def, n.cfg).qps ?? 0));
  const cacheNeed = s.cacheFirst ? s.peakQps : originPeak * s.readRatio * s.cacheable;

  // ---- latency (synchronous path only)
  const parts: { label: string; ms: number }[] = [];
  const syncLat = (cap: Parameters<Graph['list']>[0]): GNode | undefined => {
    const nodes = g.list(cap, 'sync');
    if (!nodes.length) return undefined;
    return nodes.reduce((a, b) => (serviceLatency(b.def, b.cfg) > serviceLatency(a.def, a.cfg) ? b : a));
  };
  let latencyMs = 0;
  if (cdnOffload >= 0.95 && cdnNodes.length) {
    const ms = serviceLatency(cdnNodes[0].def, cdnNodes[0].cfg);
    parts.push({ label: `${cdnNodes[0].def.name} (edge hit)`, ms });
    latencyMs = ms;
  } else {
    const push = (n: GNode | undefined) => {
      if (!n) return;
      const ms = serviceLatency(n.def, n.cfg);
      if (ms > 0) {
        parts.push({ label: n.def.name, ms });
        latencyMs += ms;
      }
    };
    push(syncLat('waf'));
    push(syncLat('apigw'));
    push(syncLat('lb'));
    push(syncLat('auth'));
    push(syncLat('compute'));
    const cacheNode = syncLat('cache');
    const storeNode = syncLat(STORE_CAPS);
    if (cacheNode) {
      push(cacheNode);
      if (cacheHitEff < 0.95) push(storeNode);
    } else {
      push(storeNode);
    }
    push(syncLat('blob'));
    push(syncLat('search'));
    push(syncLat('ml'));
    push(syncLat('geo'));
    push(syncLat('external'));
  }

  return {
    g,
    cost,
    originPeak,
    cdnOffload,
    cacheLinked,
    cacheHitEff,
    computeCap,
    computeNeed,
    dbReadCap,
    dbReadNeed,
    dbWriteCap,
    dbWriteNeed,
    storageCap,
    storageNeed,
    cacheCap,
    cacheNeed,
    latencyMs,
    latencyParts: parts,
    overProvision: computeNeed > 0 ? computeCap / computeNeed : 1,
  };
}
