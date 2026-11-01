'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Background, BackgroundVariant, Controls, Handle, MiniMap, Panel, Position, ReactFlow, useNodesState } from '@xyflow/react';
import type { Edge, Node, NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { PROBLEMS, TIERS } from '@/lib/problems';
import type { Problem, Tier } from '@/lib/types';
import { loadMindMap, saveMindMap } from '@/lib/storage';
import { useTheme } from './ThemeToggle';

const TIER_HEX: Record<Tier, string> = {
  beginner: '#10b981',
  mid: '#f59e0b',
  senior: '#f43f5e',
  staff: '#8b5cf6',
};

const LEAF_W = 210;
const LEAF_H = 36;
const STEP = 46;
const GROUP_GAP = 64;
const TIER_W = 176;
const TIER_H = 58;
const CENTER_W = 172;
const CENTER_H = 64;
const LEAF_DX = 400; // leaf column distance from centre
const TIER_DX = 230; // tier column distance from centre

// left side: beginner over mid; right side: senior over staff
const SIDES: { dir: -1 | 1; tiers: Tier[] }[] = [
  { dir: -1, tiers: ['beginner', 'mid'] },
  { dir: 1, tiers: ['senior', 'staff'] },
];

type CenterData = { title: string; sub: string } & Record<string, unknown>;
type TierData = { tier: Tier; label: string; count: number; collapsed: boolean; hex: string } & Record<string, unknown>;
type LeafData = { problem: Problem; hex: string; best?: number; studied: boolean; dim: boolean } & Record<string, unknown>;

const handles = (
  <>
    <Handle id="l" type="source" position={Position.Left} isConnectable={false} className="!h-1 !w-1 !border-0 !bg-transparent" />
    <Handle id="r" type="source" position={Position.Right} isConnectable={false} className="!h-1 !w-1 !border-0 !bg-transparent" />
    <Handle id="l" type="target" position={Position.Left} isConnectable={false} className="!h-1 !w-1 !border-0 !bg-transparent" />
    <Handle id="r" type="target" position={Position.Right} isConnectable={false} className="!h-1 !w-1 !border-0 !bg-transparent" />
  </>
);

function CenterNode({ data }: NodeProps<Node<CenterData>>) {
  return (
    <div
      className="flex cursor-grab flex-col items-center justify-center rounded-2xl bg-slate-900 text-center text-white shadow-lg active:cursor-grabbing"
      style={{ width: CENTER_W, height: CENTER_H }}
    >
      {handles}
      <div className="text-[15px] font-semibold leading-tight">{data.title}</div>
      <div className="text-[11px] opacity-70">{data.sub}</div>
    </div>
  );
}

function TierNode({ data }: NodeProps<Node<TierData>>) {
  return (
    <div
      className="flex cursor-pointer flex-col items-center justify-center rounded-xl text-center text-white shadow-sm transition hover:brightness-95"
      style={{ width: TIER_W, height: TIER_H, backgroundColor: data.hex }}
      title="Drag to move this level with its topics. Click to collapse or expand."
    >
      {handles}
      <span className="text-[14px] font-semibold leading-tight">{data.label}</span>
      <span className="text-[11px] opacity-90">
        {data.count} problems{data.collapsed ? ' · show' : ''}
      </span>
    </div>
  );
}

function LeafNode({ data }: NodeProps<Node<LeafData>>) {
  const p = data.problem;
  return (
    <div
      title={p.tagline}
      className="flex cursor-pointer items-center gap-2 rounded-lg border bg-white px-2.5 text-[13px] text-slate-800 shadow-sm transition hover:shadow-md"
      style={{ width: LEAF_W, height: LEAF_H, borderColor: `${data.hex}88`, opacity: data.dim ? 0.25 : 1 }}
    >
      {handles}
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: data.hex }} />
      <span className="min-w-0 flex-1 truncate">{p.title}</span>
      {data.best !== undefined ? (
        <span className="shrink-0 text-[11px] font-semibold text-slate-500">{Math.round(data.best)}</span>
      ) : data.studied ? (
        <span className="shrink-0 text-[11px] text-slate-400" title="Studied">
          ✓
        </span>
      ) : null}
    </div>
  );
}

const nodeTypes = { 'mm-center': CenterNode, 'mm-tier': TierNode, 'mm-leaf': LeafNode };

interface Skeleton {
  id: string;
  type: 'mm-center' | 'mm-tier' | 'mm-leaf';
  parentId?: string;
  tier?: Tier;
  problem?: Problem;
  pos: { x: number; y: number };
}

/** Default positions. Children are positioned relative to their parent so dragging a parent drags its subtree. */
function skeleton(): Skeleton[] {
  const heights = SIDES.map((s) => s.tiers.reduce((sum, t, i) => sum + PROBLEMS.filter((p) => p.tier === t).length * STEP + (i ? GROUP_GAP : 0), 0));
  const out: Skeleton[] = [{ id: 'center', type: 'mm-center', pos: { x: -CENTER_W / 2, y: -CENTER_H / 2 } }];
  SIDES.forEach((s, si) => {
    let y = -heights[si] / 2; // relative to centre y = 0
    for (const t of s.tiers) {
      const probs = PROBLEMS.filter((p) => p.tier === t);
      const top = y;
      const bottom = y + probs.length * STEP;
      const tierCx = s.dir * TIER_DX;
      const tierCy = (top + bottom) / 2;
      out.push({ id: `tier:${t}`, type: 'mm-tier', parentId: 'center', tier: t, pos: { x: tierCx - TIER_W / 2 - -CENTER_W / 2, y: tierCy - TIER_H / 2 - -CENTER_H / 2 } });
      probs.forEach((p, i) => {
        const leafCx = s.dir * LEAF_DX;
        const leafCy = top + i * STEP + STEP / 2;
        // relative to the tier's top-left
        out.push({
          id: p.id,
          type: 'mm-leaf',
          parentId: `tier:${t}`,
          tier: t,
          problem: p,
          pos: { x: leafCx - LEAF_W / 2 - (tierCx - TIER_W / 2), y: leafCy - LEAF_H / 2 - (tierCy - TIER_H / 2) },
        });
      });
      y = bottom + GROUP_GAP;
    }
  });
  return out;
}

export function MindMap({
  best,
  studied,
  match,
}: {
  best: Record<string, number>;
  studied: Record<string, boolean>;
  match: (p: Problem) => boolean;
}) {
  const router = useRouter();
  const theme = useTheme();
  const skel = useMemo(skeleton, []);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(
    skel.map((s) => ({ id: s.id, type: s.type, position: s.pos, ...(s.parentId ? { parentId: s.parentId } : {}), data: {} })),
  );
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const [ready, setReady] = useState(false);

  // restore the learner's own arrangement
  useEffect(() => {
    const saved = loadMindMap();
    if (saved) setNodes((ns) => ns.map((n) => (saved[n.id] ? { ...n, position: saved[n.id] } : n)));
    setReady(true);
  }, [setNodes]);

  const onDragStop = useCallback(() => {
    const m: Record<string, { x: number; y: number }> = {};
    for (const n of nodesRef.current) m[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    saveMindMap(m);
  }, []);

  const resetLayout = () => {
    setNodes((ns) => ns.map((n) => ({ ...n, position: skel.find((s) => s.id === n.id)?.pos ?? n.position })));
    saveMindMap(null);
  };

  const display = useMemo<Node[]>(
    () =>
      nodes.map((n) => {
        const s = skel.find((x) => x.id === n.id) as Skeleton;
        if (s.type === 'mm-center') return { ...n, draggable: true, data: { title: 'System Design', sub: `${PROBLEMS.length} problems · 4 levels` } satisfies CenterData };
        if (s.type === 'mm-tier') {
          const meta = TIERS.find((m) => m.id === s.tier)!;
          return {
            ...n,
            data: {
              tier: s.tier as Tier,
              label: meta.label.split(' / ')[0],
              count: PROBLEMS.filter((p) => p.tier === s.tier).length,
              collapsed: !!collapsed[s.tier as string],
              hex: TIER_HEX[s.tier as Tier],
            } satisfies TierData,
          };
        }
        const p = s.problem as Problem;
        return {
          ...n,
          hidden: !!collapsed[s.tier as string],
          data: { problem: p, hex: TIER_HEX[p.tier], best: best[p.id], studied: !!studied[p.id], dim: !match(p) } satisfies LeafData,
        };
      }),
    [nodes, skel, collapsed, best, studied, match],
  );

  const edges = useMemo<Edge[]>(() => {
    const out: Edge[] = [];
    for (const s of skel) {
      if (!s.parentId) continue;
      const tier = s.tier as Tier;
      const left = SIDES[0].tiers.includes(tier);
      const hex = TIER_HEX[tier];
      const dim = s.problem ? !match(s.problem) : false;
      out.push({
        id: `e:${s.id}`,
        source: s.parentId,
        target: s.id,
        sourceHandle: left ? 'l' : 'r',
        targetHandle: left ? 'r' : 'l',
        type: 'default',
        hidden: s.type === 'mm-leaf' && !!collapsed[tier],
        selectable: false,
        style: { stroke: hex, strokeWidth: s.type === 'mm-tier' ? 2.4 : 1.4, opacity: dim ? 0.12 : s.type === 'mm-tier' ? 0.75 : 0.45 },
      });
    }
    return out;
  }, [skel, collapsed, match]);

  return (
    <div className="h-[680px] overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <ReactFlow
        nodes={display}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onDragStop}
        onNodeClick={(_e, node) => {
          if (node.type === 'mm-leaf') router.push(`/design/${node.id}`);
          else if (node.type === 'mm-tier') {
            const t = node.id.replace('tier:', '');
            setCollapsed((c) => ({ ...c, [t]: !c[t] }));
          }
        }}
        nodeDragThreshold={5}
        nodesConnectable={false}
        elementsSelectable={false}
        colorMode={theme}
        fitView
        fitViewOptions={{ padding: 0.08 }}
        minZoom={0.3}
        maxZoom={1.6}
        zoomOnScroll={false}
        preventScrolling={false}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        style={{ opacity: ready ? 1 : 0 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color={theme === 'dark' ? '#2a2a2a' : '#e2e8f0'} />
        <Controls showInteractive={false} position="bottom-right" />
        <MiniMap
          pannable
          zoomable
          position="bottom-left"
          nodeColor={(n: Node) => (n.type === 'mm-tier' ? (n.data as TierData).hex : n.type === 'mm-leaf' ? (n.data as LeafData).hex : '#64748b')}
          style={{ width: 130, height: 90 }}
        />
        <Panel position="top-right">
          <button type="button" onClick={resetLayout} className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] text-slate-600 shadow-sm hover:bg-slate-50">
            Reset layout
          </button>
        </Panel>
        <Panel position="top-left">
          <div className="rounded-md bg-white/80 px-2.5 py-1 text-[11px] text-slate-500">Drag any node · pinch or use +/− to zoom · click a level to collapse</div>
        </Panel>
      </ReactFlow>
    </div>
  );
}
