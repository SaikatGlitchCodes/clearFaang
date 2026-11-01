'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Node } from '@xyflow/react';
import type { Problem } from '@/lib/types';
import { CATEGORY_HEX, SERVICE_MAP, serviceCapacity, serviceCost } from '@/lib/catalog';
import { COMPARE, RANK_LABEL } from '@/lib/compare';
import type { Ranks } from '@/lib/compare';
import { ctxFor } from '@/lib/cost';
import { fmtGB, fmtMoney, fmtNum } from '@/lib/format';
import { ServiceIcon } from './icons';
import type { ServiceFlowNode } from './flow';

const W = 200;
const H = 80;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const rectOf = (n: { position: { x: number; y: number }; measured?: { width?: number; height?: number } }): Rect => ({
  x: n.position.x,
  y: n.position.y,
  w: n.measured?.width ?? W,
  h: n.measured?.height ?? H,
});
function overlapRatio(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / Math.min(a.w * a.h, b.w * b.h);
}

export interface ComparePair {
  a: { id: string; serviceId: string };
  b: { id: string; serviceId: string };
}

/**
 * Drag one service on top of another and let go: a comparison pops up and the dragged node
 * snaps back to where it was. While dragging, the node underneath is flagged as the drop target.
 */
export function useCompareDrop(getNodes: () => ServiceFlowNode[], setNodes: Dispatch<SetStateAction<ServiceFlowNode[]>>) {
  const [target, setTarget] = useState<string | null>(null);
  const [pair, setPair] = useState<ComparePair | null>(null);
  const start = useRef<{ id: string; x: number; y: number } | null>(null);

  const findTarget = useCallback(
    (node: Node): ServiceFlowNode | null => {
      if (node.type !== 'service') return null;
      const me = getNodes().find((n) => n.id === node.id);
      if (!me || !COMPARE[me.data.serviceId]) return null;
      const mine = rectOf({ position: node.position, measured: node.measured });
      let best: ServiceFlowNode | null = null;
      let bestR = 0.45;
      for (const n of getNodes()) {
        if (n.id === node.id || n.data.serviceId === me.data.serviceId || !COMPARE[n.data.serviceId]) continue;
        const o = overlapRatio(mine, rectOf(n));
        if (o > bestR) {
          bestR = o;
          best = n;
        }
      }
      return best;
    },
    [getNodes],
  );

  const onNodeDragStart = useCallback((_e: unknown, node: Node) => {
    start.current = { id: node.id, x: node.position.x, y: node.position.y };
  }, []);

  const onNodeDrag = useCallback(
    (_e: unknown, node: Node) => {
      const t = findTarget(node);
      setTarget(t ? t.id : null);
    },
    [findTarget],
  );

  const onNodeDragStop = useCallback(
    (_e: unknown, node: Node) => {
      const t = findTarget(node);
      setTarget(null);
      const s = start.current;
      if (!t || !s || s.id !== node.id) return;
      const me = getNodes().find((n) => n.id === node.id);
      if (!me) return;
      setNodes((nds) => nds.map((n) => (n.id === s.id ? { ...n, position: { x: s.x, y: s.y } } : n)));
      setPair({ a: { id: me.id, serviceId: me.data.serviceId }, b: { id: t.id, serviceId: t.data.serviceId } });
    },
    [findTarget, getNodes, setNodes],
  );

  return { target, pair, close: () => setPair(null), onNodeDragStart, onNodeDrag, onNodeDragStop };
}

// ---------------------------------------------------------------------------------------

function Bars({ ra, rb }: { ra: Ranks; rb: Ranks }) {
  return (
    <>
      {(Object.keys(RANK_LABEL) as (keyof Ranks)[]).map((k) => (
        <div key={k} className="grid grid-cols-[1fr_110px_1fr] items-center gap-3 border-t border-slate-100 py-1.5">
          <Bar v={ra[k]} win={ra[k] > rb[k]} />
          <div className="text-center text-[11px] text-slate-500">{RANK_LABEL[k]}</div>
          <Bar v={rb[k]} win={rb[k] > ra[k]} />
        </div>
      ))}
    </>
  );
}

function Bar({ v, win }: { v: number; win: boolean }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={`h-2 flex-1 rounded-sm ${i <= v ? (win ? 'bg-emerald-500' : 'bg-slate-400') : 'bg-slate-100'}`} />
      ))}
    </div>
  );
}

function capText(serviceId: string): string {
  const c = serviceCapacity(SERVICE_MAP[serviceId], undefined);
  const parts: string[] = [];
  if (c.readQps !== undefined || c.writeQps !== undefined) parts.push(`${fmtNum(c.readQps ?? 0)} reads/s, ${fmtNum(c.writeQps ?? 0)} writes/s`);
  else if (c.qps !== undefined) parts.push(`${fmtNum(c.qps)} req/s`);
  if (c.storageGB !== undefined) parts.push(`${fmtGB(c.storageGB)}`);
  return parts.join(' · ') || 'Managed (no fixed ceiling)';
}

function Head({ serviceId }: { serviceId: string }) {
  const def = SERVICE_MAP[serviceId];
  const info = COMPARE[serviceId];
  return (
    <div>
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white" style={{ backgroundColor: CATEGORY_HEX[def.category] }}>
          <ServiceIcon name={def.icon} className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold text-slate-900">{def.name}</div>
          <div className="text-[11px] text-slate-500">{def.category}</div>
        </div>
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-slate-600">{info.tag}</p>
    </div>
  );
}

function Row({ label, a, b }: { label: string; a: string; b: string }) {
  return (
    <div className="grid grid-cols-[1fr_110px_1fr] gap-3 border-t border-slate-100 py-1.5 text-[12px] leading-snug">
      <div className="text-slate-800">{a}</div>
      <div className="text-center text-[11px] text-slate-500">{label}</div>
      <div className="text-slate-800">{b}</div>
    </div>
  );
}

function Lists({ serviceId }: { serviceId: string }) {
  const info = COMPARE[serviceId];
  return (
    <div className="text-[12px] leading-snug">
      <div className="mb-1 font-semibold text-emerald-700">Use it when</div>
      <ul className="mb-3 space-y-1">
        {info.use.map((t) => (
          <li key={t} className="flex gap-2 text-slate-700">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
            {t}
          </li>
        ))}
      </ul>
      <div className="mb-1 font-semibold text-red-700">Avoid it when</div>
      <ul className="space-y-1">
        {info.avoid.map((t) => (
          <li key={t} className="flex gap-2 text-slate-700">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CompareModal({
  pair,
  problem,
  onClose,
  onSwitch,
}: {
  pair: ComparePair;
  problem: Problem;
  onClose: () => void;
  onSwitch: (nodeId: string, serviceId: string) => void;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const A = pair.a.serviceId;
  const B = pair.b.serviceId;
  const da = SERVICE_MAP[A];
  const db = SERVICE_MAP[B];
  const ia = COMPARE[A];
  const ib = COMPARE[B];
  const ctx = ctxFor(problem);
  const costA = serviceCost(da, undefined, ctx);
  const costB = serviceCost(db, undefined, ctx);
  const sameJob = da.provides.some((p) => p !== 'client' && db.provides.includes(p));

  const take: string[] = [];
  (Object.keys(RANK_LABEL) as (keyof Ranks)[]).forEach((k) => {
    if (ia.ranks[k] !== ib.ranks[k]) take.push(`${ia.ranks[k] > ib.ranks[k] ? da.name : db.name} is stronger on "${RANK_LABEL[k].toLowerCase()}".`);
  });
  if (Math.abs(costA - costB) > 1) take.push(`At default size for this workload ${costA < costB ? da.name : db.name} is cheaper (${fmtMoney(Math.min(costA, costB))} vs ${fmtMoney(Math.max(costA, costB))} a month).`);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onMouseDown={onClose}>
      <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              {da.name} vs {db.name}
            </h2>
            <p className="text-[12px] text-slate-500">
              {sameJob ? 'These can do the same job. Which fits depends on your workload.' : 'These usually do different jobs and are often used together, not instead of each other.'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md border border-slate-200 px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50">
            Close
          </button>
        </div>

        <div className="grid grid-cols-[1fr_110px_1fr] gap-3 pb-3">
          <Head serviceId={A} />
          <div />
          <Head serviceId={B} />
        </div>

        <Bars ra={ia.ranks} rb={ib.ranks} />
        <Row label="Scales" a={ia.scales} b={ib.scales} />
        <Row label="Guarantees" a={ia.guarantees} b={ib.guarantees} />
        <Row label="Latency" a={ia.latency} b={ib.latency} />
        <Row label="Ops effort" a={ia.ops} b={ib.ops} />
        <Row label="Pricing" a={ia.pricing} b={ib.pricing} />
        <Row label="Default size" a={`${capText(A)} · ${fmtMoney(costA)}/mo`} b={`${capText(B)} · ${fmtMoney(costB)}/mo`} />

        <div className="mt-5 grid gap-6 sm:grid-cols-2">
          <Lists serviceId={A} />
          <Lists serviceId={B} />
        </div>

        {take.length > 0 && (
          <div className="mt-5 rounded-lg bg-slate-50 p-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Quick take</div>
            <ul className="space-y-0.5 text-[12px] text-slate-700">
              {take.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              onSwitch(pair.b.id, A);
              onClose();
            }}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            Switch the {db.name} node to {da.name}
          </button>
          <button
            type="button"
            onClick={() => {
              onSwitch(pair.a.id, B);
              onClose();
            }}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            Switch the {da.name} node to {db.name}
          </button>
          <span className="ml-auto text-[11px] text-slate-500">Switching keeps connections and resets that node to default settings.</span>
        </div>
      </div>
    </div>
  );
}
