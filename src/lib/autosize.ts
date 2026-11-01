// "Auto-size": bump the scale fields of each service just enough to cover the problem's load
// (with headroom). Pure function: returns a new design plus a human-readable change log.
// Only dimensions that the problem actually grades are sized, so the button never burns
// money on capacity the rubric does not care about.

import type { Capacity, Config, Design, Problem } from './types';
import { SERVICE_MAP, resolveConfig } from './catalog';
import { analyze } from './analysis';
import { replaceService } from './design';
import { rubricFor } from './rubric';

export interface AutosizeResult {
  design: Design;
  changes: string[];
}

const KEYS = ['qps', 'readQps', 'writeQps', 'storageGB'] as const;

function satisfied(cap: Capacity, need: Capacity): boolean {
  for (const k of KEYS) {
    const n = need[k];
    if (n === undefined || n <= 0) continue;
    const c = cap[k];
    if (c === undefined) continue; // this service does not constrain that dimension
    if (c < n) return false;
  }
  return true;
}

function candidates(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let v = min; v <= max + 1e-9; v += step) out.push(+v.toFixed(4));
  return out;
}

export function sizeConfig(serviceId: string, cfg: Config, need: Capacity): Config {
  const def = SERVICE_MAP[serviceId];
  if (!def) return cfg;
  let c = resolveConfig(def, cfg);
  const capOf = (x: Config): Capacity => (def.capacity ? def.capacity(x) : {});

  if (need.storageGB && def.storageField && Number(c[def.storageField]) < need.storageGB) {
    c = { ...c, [def.storageField]: Math.ceil(need.storageGB) };
  }
  if (satisfied(capOf(c), need)) return c;

  for (const key of def.scaleFields ?? []) {
    const f = def.fields.find((x) => x.key === key);
    if (!f) continue;
    const cur = Number(c[key]);
    const values =
      f.type === 'select'
        ? (f.options ?? []).map((o) => Number(o.value))
        : candidates(f.min ?? 1, f.max ?? 1, f.step ?? 1);
    for (const v of values) {
      if (v < cur) continue;
      c = { ...c, [key]: f.type === 'select' ? String(v) : v };
      if (satisfied(capOf(c), need)) return c;
    }
  }
  return c;
}

export function autosize(d: Design, p: Problem, headroom = 1.3): AutosizeResult {
  const a = analyze(d, p);
  const g = a.g;
  const s = p.scale;
  const wants = new Set(rubricFor(p).map((r) => r.req));
  const changes: string[] = [];
  let out: Design = d;

  const setConfig = (nodeId: string, next: Config, label: string) => {
    const node = out.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const def = SERVICE_MAP[node.serviceId];
    const prev = resolveConfig(def, node.config);
    const diffs: string[] = [];
    for (const f of def.fields) {
      if (String(prev[f.key]) !== String(next[f.key])) diffs.push(`${f.label} ${prev[f.key]} → ${next[f.key]}`);
    }
    if (!diffs.length) return;
    out = { ...out, nodes: out.nodes.map((n) => (n.id === nodeId ? { ...n, config: next } : n)) };
    changes.push(`${label}: ${diffs.join(', ')}`);
  };

  // 1) front-line compute shares the origin load
  if (wants.has('compute-capacity')) {
    let compute = g.list('compute', 'sync');
    if (!compute.length) compute = g.list('compute');
    const per = (a.computeNeed * headroom) / Math.max(1, compute.length);
    for (const n of compute) setConfig(n.id, sizeConfig(n.def.id, n.cfg, { qps: per }), n.label);
  }

  // 2) data stores: read / write throughput, plus bulk storage on the first one
  const wantRead = wants.has('db-read-capacity');
  const wantWrite = wants.has('db-write-capacity');
  const wantStore = wants.has('storage-capacity') && (s.storageIn === 'db' || s.storageIn === 'any');
  g.stores().forEach((n, i) => {
    const need: Capacity = {
      readQps: wantRead ? a.dbReadNeed * headroom : undefined,
      writeQps: wantWrite ? a.dbWriteNeed * headroom : undefined,
      storageGB: i === 0 && wantStore ? s.storageGB * 1.2 : undefined,
    };
    if (need.readQps === undefined && need.writeQps === undefined && need.storageGB === undefined) return;
    setConfig(n.id, sizeConfig(n.def.id, n.cfg, need), n.label);
  });

  // 3) blob storage
  const blobs = g.list('blob');
  if (blobs.length && wants.has('storage-capacity') && (s.storageIn === 'blob' || s.storageIn === 'any')) {
    const n = blobs[0];
    setConfig(n.id, sizeConfig(n.def.id, n.cfg, { storageGB: s.storageGB * 1.2 }), n.label);
  }

  // 4) caches: throughput and (for cache-resident datasets) memory
  const wantCacheQps = wants.has('cache-capacity');
  const wantCacheMem = wants.has('storage-capacity') && s.storageIn === 'cache';
  g.list('cache').forEach((n, i) => {
    const qpsNeed = wantCacheQps ? a.cacheNeed * headroom : 0;
    const memNeed = i === 0 && wantCacheMem ? s.storageGB * 1.15 : 0;
    if (!qpsNeed && !memNeed) return;
    let id = n.def.id;
    let cfg = n.cfg;
    if (id === 'memorystore' && (qpsNeed > 100_000 || memNeed > 300)) {
      out = replaceService(out, n.id, 'memorystore-cluster');
      id = 'memorystore-cluster';
      cfg = resolveConfig(SERVICE_MAP[id], undefined);
      changes.push(`${n.label}: switched to Memorystore Cluster (single Redis tops out near 100k ops/s)`);
    }
    setConfig(n.id, sizeConfig(id, cfg, { qps: qpsNeed || undefined, storageGB: memNeed || undefined }), n.label);
  });

  // 5) search clusters sized for the search share of the origin load
  for (const n of g.list('search')) {
    const share = Number(n.cfg.share ?? 5) / 100;
    setConfig(n.id, sizeConfig(n.def.id, n.cfg, { qps: a.originPeak * share * headroom }), n.label);
  }

  // 6) async pipes: brokers / workers sized for the write path
  const asyncNeed = Math.max(1, a.originPeak * (1 - s.readRatio)) * headroom;
  if (wants.has('stream-capacity') || wants.has('stream')) {
    for (const n of g.list('stream')) setConfig(n.id, sizeConfig(n.def.id, n.cfg, { qps: asyncNeed }), n.label);
  }
  for (const n of g.list('stream-processing')) setConfig(n.id, sizeConfig(n.def.id, n.cfg, { qps: asyncNeed }), n.label);

  return { design: out, changes };
}
