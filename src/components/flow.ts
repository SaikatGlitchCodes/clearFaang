// React Flow <-> Design conversion helpers and shared node typing.

import { MarkerType } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import type { Config, Design, SchemaEntity } from '@/lib/types';
import type { NodeSim } from '@/lib/simulate';

export type ServiceNodeData = {
  serviceId: string;
  config: Config;
  label?: string;
  /** Data model for database and cache nodes. */
  schema?: SchemaEntity[];
  /** Opens the data-model editor (injected by the editor for stores). */
  onSchema?: () => void;
  /** Monthly cost shown on the node badge (injected by the editor). */
  cost?: number;
  /** True when the node is not connected to the client path. */
  orphan?: boolean;
  /** Live Playground readings (injected by the editor while simulating). */
  sim?: NodeSim;
  /** Flow-trace highlight: 'on' glows, 'off' is dimmed (undefined = no trace active). */
  hl?: 'on' | 'off';
  /** True while another service is being dragged over this one (drop to compare). */
  cmp?: boolean;
} & Record<string, unknown>;

export type ServiceFlowNode = Node<ServiceNodeData, 'service'>;

export const EDGE_DEFAULTS = {
  type: 'smoothstep' as const,
  animated: true,
  markerEnd: { type: MarkerType.ArrowClosed },
};

export function toFlowNodes(d: Design): ServiceFlowNode[] {
  return d.nodes.map((n) => ({
    id: n.id,
    type: 'service' as const,
    position: { x: n.x, y: n.y },
    data: { serviceId: n.serviceId, config: n.config, label: n.label, ...(n.schema?.length ? { schema: n.schema } : {}) },
  }));
}

export function toFlowEdges(d: Design): Edge[] {
  return d.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, ...EDGE_DEFAULTS }));
}

export function fromFlow(nodes: ServiceFlowNode[], edges: Edge[]): Design {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      serviceId: n.data.serviceId,
      config: n.data.config,
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
      ...(n.data.label ? { label: n.data.label } : {}),
      ...(n.data.schema?.length ? { schema: n.data.schema } : {}),
    })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  };
}

/** Signature that ignores node positions (used to detect "did the architecture change?"). */
export function designSignature(d: Design): string {
  return JSON.stringify({
    n: d.nodes.map((n) => [n.id, n.serviceId, n.config, n.label ?? '', n.schema ?? null]),
    e: d.edges.map((e) => [e.source, e.target]),
  });
}
