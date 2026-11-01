// Pure helpers for manipulating designs (used by the editor, fixes and the reference builder).

import type { Capability, Category, Config, Design, DesignNode } from './types';
import { SERVICE_MAP, defaultConfig } from './catalog';

export const emptyDesign = (): Design => ({ nodes: [], edges: [] });

let counter = 0;
export function uid(prefix = 'n'): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function cloneDesign(d: Design): Design {
  return JSON.parse(JSON.stringify(d)) as Design;
}

const COLUMN: Record<Category, number> = {
  'Clients & External': 0,
  'Networking & Edge': 1,
  'Security & Identity': 1,
  Compute: 2,
  Caching: 3,
  'Messaging & Streaming': 3,
  Databases: 4,
  Storage: 4,
  'Data & AI': 4,
  Operations: 5,
};

export function capsOf(n: DesignNode): Capability[] {
  return SERVICE_MAP[n.serviceId]?.provides ?? [];
}

export function nodesWithCap(d: Design, cap: Capability): DesignNode[] {
  return d.nodes.filter((n) => capsOf(n).includes(cap));
}

export function hasEdge(d: Design, a: string, b: string): boolean {
  return d.edges.some((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a));
}

export function placeFor(d: Design, serviceId: string): { x: number; y: number } {
  const def = SERVICE_MAP[serviceId];
  let col = def ? COLUMN[def.category] : 2;
  if (serviceId === 'external') col = 5;
  const inCol = d.nodes.filter((n) => {
    const nd = SERVICE_MAP[n.serviceId];
    if (!nd) return false;
    const c = n.serviceId === 'external' ? 5 : COLUMN[nd.category];
    return c === col;
  });
  const maxY = inCol.reduce((m, n) => Math.max(m, n.y), -90);
  return { x: 40 + col * 270, y: inCol.length ? maxY + 120 : 60 };
}

export function addNode(
  d: Design,
  serviceId: string,
  opts: { config?: Config; label?: string; x?: number; y?: number } = {},
): { design: Design; id: string } {
  const def = SERVICE_MAP[serviceId];
  const id = uid();
  const pos = opts.x !== undefined && opts.y !== undefined ? { x: opts.x, y: opts.y } : placeFor(d, serviceId);
  const node: DesignNode = {
    id,
    serviceId,
    config: { ...(def ? defaultConfig(def) : {}), ...(opts.config ?? {}) },
    x: pos.x,
    y: pos.y,
    ...(opts.label ? { label: opts.label } : {}),
  };
  return { design: { ...d, nodes: [...d.nodes, node] }, id };
}

export function connect(d: Design, source: string, target: string): Design {
  if (source === target || hasEdge(d, source, target)) return d;
  return { ...d, edges: [...d.edges, { id: uid('e'), source, target }] };
}

export function disconnect(d: Design, a: string, b: string): Design {
  return {
    ...d,
    edges: d.edges.filter((e) => !((e.source === a && e.target === b) || (e.source === b && e.target === a))),
  };
}

const FRONT_CAPS: Capability[] = ['client', 'cdn', 'waf', 'apigw', 'lb', 'dns'];

/** The compute node closest to the user-facing edge (what an LB / cache / DB should attach to). */
export function frontCompute(d: Design): DesignNode | undefined {
  const compute = nodesWithCap(d, 'compute');
  if (!compute.length) return undefined;
  const adjacentToFront = compute.filter((c) =>
    d.edges.some((e) => {
      const other = e.source === c.id ? e.target : e.target === c.id ? e.source : null;
      if (!other) return false;
      const on = d.nodes.find((n) => n.id === other);
      return !!on && capsOf(on).some((cap) => FRONT_CAPS.includes(cap));
    }),
  );
  return (adjacentToFront[0] ?? compute[0]) as DesignNode;
}

/** First node matching any of `caps` (in preference order). 'compute' resolves to the front compute node. */
export function pickNode(d: Design, caps: Capability[]): DesignNode | undefined {
  for (const cap of caps) {
    const found = cap === 'compute' ? frontCompute(d) : nodesWithCap(d, cap)[0];
    if (found) return found;
  }
  return undefined;
}

/** Add a node and connect it *from* the first node matching `fromCaps`. */
export function attachFrom(
  d: Design,
  serviceId: string,
  fromCaps: Capability[],
  opts: { config?: Config; label?: string } = {},
): { design: Design; id: string } {
  const from = pickNode(d, fromCaps);
  const added = addNode(d, serviceId, opts);
  return { design: from ? connect(added.design, from.id, added.id) : added.design, id: added.id };
}

/**
 * Insert a node in front of a target, re-routing existing predecessor edges through it:
 *   pred -> target   becomes   pred -> new -> target
 */
export function insertBefore(
  d: Design,
  serviceId: string,
  targetCaps: Capability[],
  predCaps: Capability[],
  config?: Config,
): Design {
  const target = pickNode(d, targetCaps);
  const added = addNode(d, serviceId, { config });
  let out = added.design;
  if (!target) {
    const client = nodesWithCap(d, 'client')[0];
    return client ? connect(out, client.id, added.id) : out;
  }
  let preds: DesignNode[] = [];
  for (const cap of predCaps) {
    preds = nodesWithCap(d, cap).filter((n) => hasEdge(d, n.id, target.id));
    if (preds.length) break;
  }
  if (!preds.length) {
    const client = nodesWithCap(d, 'client')[0];
    if (client) preds = [client];
  }
  for (const p of preds) {
    out = disconnect(out, p.id, target.id);
    out = connect(out, p.id, added.id);
  }
  return connect(out, added.id, target.id);
}

export function patchServices(d: Design, serviceId: string, patch: Config): Design {
  return {
    ...d,
    nodes: d.nodes.map((n) => (n.serviceId === serviceId ? { ...n, config: { ...n.config, ...patch } } : n)),
  };
}

export function replaceService(d: Design, nodeId: string, serviceId: string, config?: Config): Design {
  const def = SERVICE_MAP[serviceId];
  if (!def) return d;
  return {
    ...d,
    nodes: d.nodes.map((n) =>
      n.id === nodeId ? { ...n, serviceId, config: { ...defaultConfig(def), ...(config ?? {}) } } : n,
    ),
  };
}
