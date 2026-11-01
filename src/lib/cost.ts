import type { CostCtx, Design, Problem } from './types';
import { SECONDS_PER_MONTH, SERVICE_MAP, resolveConfig, serviceCost } from './catalog';
import { Graph, cacheHitEffOf } from './graph';

export const EGRESS_PER_GB = 0.085;

export function ctxFor(p: Problem, readPassThrough = 1): CostCtx {
  const s = p.scale;
  return {
    avgQps: s.avgQps,
    peakQps: s.peakQps,
    readRatio: s.readRatio,
    payloadKB: s.payloadKB,
    cdnFriendly: s.cdnFriendly,
    storageGB: s.storageGB,
    computeFactor: s.computeFactor ?? 1,
    readPassThrough,
  };
}

export interface CostItem {
  nodeId: string;
  serviceId: string;
  name: string;
  monthly: number;
}

export interface CostResult {
  items: CostItem[];
  /** Internet egress that is not served through a CDN (a synthetic line, not a canvas node). */
  egress: number;
  total: number;
  byNode: Record<string, number>;
}

export function computeCost(d: Design, p: Problem): CostResult {
  const g = new Graph(d);
  const ctx = ctxFor(p, 1 - cacheHitEffOf(g, p.scale.cacheable));
  const items: CostItem[] = [];
  const byNode: Record<string, number> = {};
  let cdnShare = 0;

  for (const n of d.nodes) {
    const def = SERVICE_MAP[n.serviceId];
    if (!def) continue;
    const monthly = serviceCost(def, n.config, ctx);
    items.push({ nodeId: n.id, serviceId: def.id, name: n.label || def.name, monthly });
    byNode[n.id] = monthly;
    if (def.provides.includes('cdn')) {
      const cfg = resolveConfig(def, n.config);
      cdnShare = Math.max(cdnShare, Number(cfg.share) / 100);
    }
  }

  const egressGB = (ctx.avgQps * SECONDS_PER_MONTH * ctx.payloadKB) / 1e6;
  const coverage = Math.min(1, ctx.cdnFriendly * cdnShare);
  const egress = p.scale.internal ? 0 : egressGB * (1 - coverage) * EGRESS_PER_GB;

  const total = items.reduce((s, i) => s + i.monthly, 0) + egress;
  items.sort((a, b) => b.monthly - a.monthly);
  return { items, egress, total, byNode };
}
