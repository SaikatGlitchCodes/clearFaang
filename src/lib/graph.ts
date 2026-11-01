// Read-only graph view over a Design, with capability-aware queries.

import type { Capability, Config, Design, ServiceDef } from './types';
import { SERVICE_MAP, resolveConfig } from './catalog';

export interface GNode {
  id: string;
  label: string;
  def: ServiceDef;
  /** Fully-resolved config (defaults merged in). */
  cfg: Config;
}

/** Services that sit *off* the synchronous request path (work is handed off or happens later). */
export const ASYNC_CAPS: Capability[] = [
  'queue',
  'stream',
  'workflow',
  'scheduler',
  'stream-processing',
  'analytics',
  'push',
  'transcode',
  'observability',
];

export const STORE_CAPS: Capability[] = ['sql', 'nosql', 'wide-column', 'global-db'];

/** Nodes the synchronous request path can flow *through* (everything else is a leaf dependency). */
const EXPAND_CAPS: Capability[] = ['client', 'compute', 'lb', 'cdn', 'waf', 'apigw', 'dns'];

export type Scope = 'all' | 'reachable' | 'sync';

/** Effective share of reads a connected cache absorbs: hit ratio x cacheable fraction (capped). */
export function cacheHitEffOf(g: Graph, cacheable: number): number {
  const linked = g.list('cache').filter((c) => g.linkedTo(c, 'compute'));
  if (!linked.length) return 0;
  return Math.min(0.98, Math.max(...linked.map((c) => Number(c.cfg.hitRatio) / 100)) * cacheable);
}

export class Graph {
  nodes: GNode[] = [];
  byId = new Map<string, GNode>();
  adj = new Map<string, Set<string>>();
  reachable = new Set<string>();
  sync = new Set<string>();
  hasClient = false;

  constructor(design: Design) {
    for (const n of design.nodes) {
      const def = SERVICE_MAP[n.serviceId];
      if (!def) continue;
      const g: GNode = { id: n.id, label: n.label || def.name, def, cfg: resolveConfig(def, n.config) };
      this.nodes.push(g);
      this.byId.set(g.id, g);
      this.adj.set(g.id, new Set());
    }
    for (const e of design.edges) {
      if (!this.byId.has(e.source) || !this.byId.has(e.target) || e.source === e.target) continue;
      this.adj.get(e.source)!.add(e.target);
      this.adj.get(e.target)!.add(e.source);
    }
    const clients = this.nodes.filter((n) => n.def.provides.includes('client'));
    this.hasClient = clients.length > 0;

    if (!this.hasClient) {
      // No entry point: analyse everything so the learner still gets feedback.
      for (const n of this.nodes) {
        this.reachable.add(n.id);
        if (!this.isAsync(n)) this.sync.add(n.id);
      }
    } else {
      // reachable: undirected BFS from clients
      const q: string[] = clients.map((c) => c.id);
      q.forEach((id) => this.reachable.add(id));
      while (q.length) {
        const id = q.shift() as string;
        for (const nb of this.adj.get(id) ?? []) {
          if (!this.reachable.has(nb)) {
            this.reachable.add(nb);
            q.push(nb);
          }
        }
      }
      // sync: BFS that never enters an async service and never hops *through* a backing
      // service (a database shared by the API and a worker does not make the worker synchronous)
      const sq: string[] = clients.map((c) => c.id);
      sq.forEach((id) => this.sync.add(id));
      while (sq.length) {
        const id = sq.shift() as string;
        if (!this.is(this.byId.get(id) as GNode, EXPAND_CAPS)) continue;
        for (const nb of this.adj.get(id) ?? []) {
          const node = this.byId.get(nb) as GNode;
          if (!this.sync.has(nb) && !this.isAsync(node)) {
            this.sync.add(nb);
            sq.push(nb);
          }
        }
      }
    }
  }

  isAsync(n: GNode): boolean {
    return n.def.provides.some((c) => ASYNC_CAPS.includes(c));
  }

  is(n: GNode, cap: Capability | Capability[]): boolean {
    const caps = Array.isArray(cap) ? cap : [cap];
    return caps.some((c) => n.def.provides.includes(c));
  }

  inScope(n: GNode, scope: Scope): boolean {
    if (scope === 'all') return true;
    if (scope === 'sync') return this.sync.has(n.id);
    return this.reachable.has(n.id);
  }

  list(cap: Capability | Capability[], scope: Scope = 'reachable'): GNode[] {
    return this.nodes.filter((n) => this.inScope(n, scope) && this.is(n, cap));
  }

  has(cap: Capability | Capability[], scope: Scope = 'reachable'): boolean {
    return this.list(cap, scope).length > 0;
  }

  neighbors(n: GNode): GNode[] {
    return [...(this.adj.get(n.id) ?? [])].map((id) => this.byId.get(id) as GNode);
  }

  linkedTo(n: GNode, caps: Capability | Capability[]): boolean {
    return this.neighbors(n).some((nb) => this.is(nb, caps));
  }

  /** Is any node with `a` directly connected to any node with `b`? */
  linked(a: Capability | Capability[], b: Capability | Capability[], scope: Scope = 'reachable'): boolean {
    return this.list(a, scope).some((n) => this.linkedTo(n, b));
  }

  stores(scope: Scope = 'reachable'): GNode[] {
    return this.list(STORE_CAPS, scope);
  }

  orphans(): GNode[] {
    if (!this.hasClient) return [];
    return this.nodes.filter((n) => !this.reachable.has(n.id));
  }
}
