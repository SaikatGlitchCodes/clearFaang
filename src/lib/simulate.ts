// Playground simulation: pushes a (changing) request load through a design and estimates
// per-service CPU / memory / backlog, errors, latency and the bill at that load.
// It is a teaching model built on the same capacity numbers as the evaluator, not a benchmark.

import type { Design, Problem } from './types';
import { SECONDS_PER_MONTH, serviceCapacity } from './catalog';
import { analyze } from './analysis';
import type { GNode } from './graph';

export type Pattern = 'steady' | 'diurnal' | 'spike';

export interface LoadSpec {
  rps: number;
  readRatio: number;
  payloadKB: number;
  pattern: Pattern;
  burst: boolean;
}

export interface NodeSim {
  /** 0..100 (undefined for fully managed services with no meaningful CPU). */
  cpu?: number;
  mem?: number;
  rps: number;
  instances?: number;
  backlog?: number;
  detail?: string;
  status: 'ok' | 'warn' | 'hot';
}

export interface SimFrame {
  t: number;
  rps: number;
  originRps: number;
  errorRate: number;
  p95: number;
  maxCpu: number;
  monthly: number;
  perHour: number;
  perMillion: number;
  bottleneck: string | null;
  cacheHit: number;
  nodes: Record<string, NodeSim>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const statusOf = (cpu: number | undefined): NodeSim['status'] =>
  cpu === undefined ? 'ok' : cpu >= 90 ? 'hot' : cpu >= 70 ? 'warn' : 'ok';

/** Instantaneous request rate for the chosen traffic pattern at sim time t (seconds). */
export function loadAt(load: LoadSpec, t: number, noise: number): number {
  let f = 1;
  if (load.pattern === 'diurnal') f = 1 + 0.6 * Math.sin((2 * Math.PI * t) / 60);
  if (load.pattern === 'spike') f = t % 30 < 8 ? 4 : 1;
  if (load.burst) f *= 5;
  return Math.max(0, load.rps * f * (1 + (noise - 0.5) * 0.08));
}

export function simulateStep(
  design: Design,
  problem: Problem,
  load: LoadSpec,
  t: number,
  rps: number,
  backlog: Record<string, number>,
  dt: number,
): { frame: SimFrame; backlog: Record<string, number> } {
  const p: Problem = {
    ...problem,
    scale: { ...problem.scale, avgQps: rps, peakQps: rps, readRatio: load.readRatio, payloadKB: load.payloadKB },
  };
  const a = analyze(design, p);
  const g = a.g;
  const factor = p.scale.computeFactor ?? 1;
  const nodes: Record<string, NodeSim> = {};
  const nextBacklog: Record<string, number> = { ...backlog };
  const overloads: number[] = [];
  let worst: { name: string; cpu: number } | null = null;
  const note = (name: string, cpu: number | undefined) => {
    if (cpu !== undefined && (!worst || cpu > worst.cpu)) worst = { name, cpu };
  };

  // ---------- edge services
  for (const n of g.nodes) {
    if (g.is(n, ['lb', 'waf', 'apigw', 'dns'])) nodes[n.id] = { rps, status: 'ok', detail: 'managed' };
    if (g.is(n, 'cdn')) {
      const hit = (Number(n.cfg.hitRatio) / 100) * p.scale.cdnFriendly * (Number(n.cfg.share) / 100);
      nodes[n.id] = { rps: rps * p.scale.cdnFriendly, status: 'ok', detail: `offloads ${Math.round(hit * 100)}%` };
    }
  }

  // ---------- queues and their consumers
  const queues = g.list(['queue', 'stream']);
  const consumerLoad: Record<string, number> = {};
  for (const q of queues) {
    const share = q.cfg.share !== undefined ? Number(q.cfg.share) / 100 : 1 - load.readRatio;
    const inflow = (a.originPeak * share) / factor;
    const consumers = g.neighbors(q).filter((c) => g.is(c, 'compute') && !g.sync.has(c.id));
    const consCap = consumers.reduce((s, c) => s + (serviceCapacity(c.def, c.cfg).qps ?? 0), 0);
    const own = serviceCapacity(q.def, q.cfg).qps;
    const pipeCap = own ?? Infinity;
    const queued = backlog[q.id] ?? 0;
    const want = inflow + queued / Math.max(dt, 0.001);
    const drained = Math.min(want, consCap, pipeCap);
    nextBacklog[q.id] = Math.max(0, queued + (Math.min(inflow, pipeCap) - drained) * dt);
    if (inflow > pipeCap) overloads.push(1 - pipeCap / inflow);
    for (const c of consumers) {
      consumerLoad[c.id] = (consumerLoad[c.id] ?? 0) + (consCap > 0 ? (drained * (serviceCapacity(c.def, c.cfg).qps ?? 0)) / consCap : 0);
    }
    const cpu = own !== undefined ? clamp((inflow / own) * 100, 0, 100) : undefined;
    nodes[q.id] = {
      cpu,
      rps: inflow * factor,
      backlog: nextBacklog[q.id],
      status: nextBacklog[q.id] > inflow * 10 ? 'hot' : nextBacklog[q.id] > inflow ? 'warn' : statusOf(cpu),
      detail: `backlog ${Math.round(nextBacklog[q.id]).toLocaleString('en-US')} msgs`,
    };
    note(q.label, cpu);
  }

  // ---------- compute
  const sync = g.list('compute', 'sync');
  const syncCap = sync.reduce((s, n) => s + (serviceCapacity(n.def, n.cfg).qps ?? 0), 0);
  const computeNodes = g.list('compute');
  for (const n of computeNodes) {
    const cap = serviceCapacity(n.def, n.cfg).qps ?? 1;
    const isSync = g.sync.has(n.id) || (!sync.length && true);
    const load2 = isSync ? (syncCap > 0 ? (a.computeNeed * cap) / syncCap : 0) : consumerLoad[n.id] ?? 0;
    const auto = n.def.id === 'cloud-run' || n.def.id === 'functions';
    let cpu: number;
    let instances: number | undefined;
    if (auto) {
      const maxI = Number(n.cfg.maxInstances);
      const perInst = cap / Math.max(1, maxI);
      const minI = n.def.id === 'cloud-run' ? Number(n.cfg.minInstances) : 0;
      instances = clamp(Math.ceil(load2 / (perInst * 0.6)), Math.max(minI, load2 > 0 ? 1 : 0), maxI);
      cpu = instances > 0 ? clamp((load2 / (instances * perInst)) * 100, 0, 100) : 0;
    } else {
      cpu = clamp((load2 / cap) * 100, 0, 100);
    }
    const mem = clamp(22 + 0.5 * cpu + (instances ? 0 : 8), 0, 100);
    nodes[n.id] = {
      cpu,
      mem,
      rps: load2 * factor,
      instances,
      status: statusOf(cpu),
      detail: instances !== undefined ? `${instances} of ${n.cfg.maxInstances} instances` : undefined,
    };
    if (isSync && load2 > cap) overloads.push(1 - cap / load2);
    note(n.label, cpu);
  }
  if (syncCap > 0 && a.computeNeed > syncCap) overloads.push(1 - syncCap / a.computeNeed);

  // ---------- data stores
  const stores = g.stores();
  const rCap = stores.reduce((s, n) => s + (serviceCapacity(n.def, n.cfg).readQps ?? 0), 0);
  const wCap = stores.reduce((s, n) => s + (serviceCapacity(n.def, n.cfg).writeQps ?? 0), 0);
  const rUtil = rCap > 0 ? a.dbReadNeed / rCap : 0;
  const wUtil = wCap > 0 ? a.dbWriteNeed / wCap : 0;
  if (stores.length) {
    if (rUtil > 1) overloads.push(1 - 1 / rUtil);
    if (wUtil > 1) overloads.push(1 - 1 / wUtil);
  }
  for (const n of stores) {
    const cpu = clamp(Math.max(rUtil, wUtil) * 100, 0, 100);
    const sc = serviceCapacity(n.def, n.cfg).storageGB ?? 0;
    const fill = sc > 0 ? clamp(p.scale.storageGB / sc, 0, 1) : 0.3;
    nodes[n.id] = {
      cpu,
      mem: clamp(32 + 0.35 * cpu + 15 * fill, 0, 100),
      rps: a.dbReadNeed + a.dbWriteNeed,
      status: statusOf(cpu),
      detail: `${Math.round(a.dbReadNeed).toLocaleString('en-US')} reads/s · ${Math.round(a.dbWriteNeed).toLocaleString('en-US')} writes/s`,
    };
    note(n.label, cpu);
  }

  // ---------- caches
  const caches = g.list('cache');
  const cCap = caches.reduce((s, n) => s + (serviceCapacity(n.def, n.cfg).qps ?? 0), 0);
  const cMem = caches.reduce((s, n) => s + (serviceCapacity(n.def, n.cfg).storageGB ?? 0), 0);
  const ws = p.scale.storageIn === 'cache' ? p.scale.storageGB : Math.max(1, p.scale.storageGB * 0.02);
  for (const n of caches) {
    const cpu = cCap > 0 ? clamp((a.cacheNeed / cCap) * 100, 0, 100) : 0;
    nodes[n.id] = {
      cpu,
      mem: cMem > 0 ? clamp(15 + 85 * (ws / cMem), 0, 100) : 0,
      rps: a.cacheNeed,
      status: statusOf(cpu),
      detail: a.cacheLinked ? `absorbing ~${Math.round(a.cacheHitEff * 100)}% of reads` : 'not connected to compute',
    };
    note(n.label, cpu);
  }
  if (p.scale.cacheFirst && cCap > 0 && a.cacheNeed > cCap) overloads.push(1 - cCap / a.cacheNeed);

  // ---------- everything else that has a qps ceiling
  for (const n of g.nodes) {
    if (nodes[n.id]) continue;
    const cap = serviceCapacity(n.def, n.cfg).qps;
    if (g.is(n, ['search', 'ml', 'stream-processing']) && cap) {
      const inflow = g.is(n, 'search') ? a.originPeak * (Number(n.cfg.share ?? 5) / 100) : a.originPeak * (1 - load.readRatio);
      const cpu = clamp((inflow / cap) * 100, 0, 100);
      nodes[n.id] = { cpu, mem: clamp(25 + 0.5 * cpu, 0, 100), rps: inflow, status: statusOf(cpu) };
      if (g.is(n, 'search') && inflow > cap) overloads.push(1 - cap / inflow);
      note(n.label, cpu);
    } else if (!g.is(n, 'client')) {
      nodes[n.id] = { rps, status: 'ok', detail: 'managed' };
    }
  }

  // ---------- roll-ups
  const errorRate = clamp(1 - overloads.reduce((acc, o) => acc * (1 - clamp(o, 0, 1)), 1), 0, 0.99);
  const maxCpu = Object.values(nodes).reduce((m, n) => Math.max(m, n.cpu ?? 0), 0);
  const util = maxCpu / 100;
  const qf = util < 0.6 ? 1 : 1 + Math.pow((util - 0.6) / 0.4, 2) * 4;
  const monthly = a.cost.total;
  const perMillion = rps > 0 ? monthly / ((rps * SECONDS_PER_MONTH) / 1e6) : 0;
  const b = worst as { name: string; cpu: number } | null;

  return {
    frame: {
      t,
      rps,
      originRps: a.originPeak,
      errorRate,
      p95: a.latencyMs * qf,
      maxCpu,
      monthly,
      perHour: monthly / 730,
      perMillion,
      bottleneck: b && b.cpu >= 70 ? b.name : null,
      cacheHit: a.cacheHitEff,
      nodes,
    },
    backlog: nextBacklog,
  };
}

export type { GNode };
