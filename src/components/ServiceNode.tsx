'use client';

import { useRef } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { CATEGORY_HEX, SERVICE_MAP, serviceChips } from '@/lib/catalog';
import { fmtMoney } from '@/lib/format';
import { schemaLines } from '@/lib/schema';
import { ServiceIcon } from './icons';
import type { ServiceFlowNode } from './flow';

export function ServiceNode({ data, selected }: NodeProps<ServiceFlowNode>) {
  const def = SERVICE_MAP[data.serviceId];
  if (!def) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700">
        Unknown service
      </div>
    );
  }
  const press = useRef<{ t: number; x: number; y: number } | null>(null);
  const cancelPress = () => {
    if (press.current) {
      window.clearTimeout(press.current.t);
      press.current = null;
    }
  };
  const color = CATEGORY_HEX[def.category];
  const title = data.label || def.name;
  const chips = serviceChips(def, data.config);

  return (
    <div
      onPointerDown={(e) => {
        if (!data.onSchema || e.button !== 0) return;
        cancelPress();
        press.current = {
          t: window.setTimeout(() => {
            press.current = null;
            data.onSchema?.();
          }, 550),
          x: e.clientX,
          y: e.clientY,
        };
      }}
      onPointerMove={(e) => {
        const p = press.current;
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) cancelPress();
      }}
      onPointerUp={cancelPress}
      onPointerLeave={cancelPress}
      title={data.onSchema ? 'Hold to edit the data model' : undefined}
      className="sds-node relative w-[200px] rounded-xl border bg-white px-3 py-2.5 shadow-sm transition-shadow"
      style={{
        borderColor: selected ? color : data.sim?.status === 'hot' ? '#ef4444' : data.sim?.status === 'warn' ? '#f59e0b' : data.orphan ? '#f59e0b' : undefined,
        boxShadow: data.cmp ? '0 0 0 4px #6366f199' : selected ? `0 0 0 3px ${color}33` : data.hl === 'on' ? '0 0 0 4px #f59e0b66' : undefined,
        opacity: data.hl === 'off' ? 0.35 : undefined,
        transition: 'opacity 0.15s, box-shadow 0.15s',
      }}
    >
      <Handle type="target" position={Position.Left} id="l" className="!h-2.5 !w-2.5 !border-white !bg-slate-400" />
      <Handle type="source" position={Position.Right} id="r" className="!h-2.5 !w-2.5 !border-white !bg-slate-400" />
      <Handle type="target" position={Position.Top} id="t" className="!h-2.5 !w-2.5 !border-white !bg-slate-400" />
      <Handle type="source" position={Position.Bottom} id="b" className="!h-2.5 !w-2.5 !border-white !bg-slate-400" />

      <div className="flex items-center gap-2.5">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white"
          style={{ backgroundColor: color }}
        >
          <ServiceIcon name={def.icon} className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold leading-tight text-slate-900">{title}</div>
          <div className="truncate text-[11px] leading-tight text-slate-500">
            {data.label ? def.name : def.category}
          </div>
        </div>
      </div>
      {chips ? <div className="mt-1.5 truncate text-[11px] text-slate-600">{chips}</div> : null}

      {data.onSchema ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            data.onSchema?.();
          }}
          className="nodrag mt-1.5 block w-full rounded-md border border-dashed border-slate-300 px-1.5 py-1 text-left text-[10.5px] leading-snug text-slate-500 hover:bg-slate-50"
        >
          {data.schema?.length ? (
            schemaLines(data.schema, 2).map((l) => (
              <span key={l} className="block truncate font-mono">
                {l}
              </span>
            ))
          ) : (
            '+ data model (or hold the node)'
          )}
        </button>
      ) : null}

      {data.sim && (data.sim.cpu !== undefined || data.sim.mem !== undefined) ? (
        <div className="mt-2 space-y-1">
          {(['cpu', 'mem'] as const).map((k) => {
            const v = data.sim?.[k];
            if (v === undefined) return null;
            const tone = v >= 90 ? 'bg-red-500' : v >= 70 ? 'bg-amber-500' : 'bg-emerald-500';
            return (
              <div key={k} className="flex items-center gap-1.5">
                <span className="w-6 text-[9px] uppercase text-slate-500">{k}</span>
                <div className="h-1.5 flex-1 rounded-full bg-slate-100">
                  <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, v)}%`, transition: 'width 0.4s' }} />
                </div>
                <span className="w-8 text-right text-[10px] text-slate-600">{Math.round(v)}%</span>
              </div>
            );
          })}
          {data.sim.instances !== undefined ? (
            <div className="text-[10px] text-slate-500">{data.sim.instances} instances</div>
          ) : null}
          {data.sim.backlog !== undefined ? (
            <div className={`text-[10px] ${data.sim.status === 'ok' ? 'text-slate-500' : 'text-amber-600'}`}>
              backlog {Math.round(data.sim.backlog).toLocaleString('en-US')}
            </div>
          ) : null}
        </div>
      ) : null}

      {typeof data.cost === 'number' && data.cost > 0 ? (
        <span className="absolute -right-2 -top-2.5 rounded-full bg-slate-900 px-1.5 py-0.5 text-[10px] font-medium text-white shadow">
          {fmtMoney(data.cost)}/mo
        </span>
      ) : null}
      {data.cmp ? (
        <span className="absolute -bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-medium text-white shadow">
          Drop to compare
        </span>
      ) : null}
      {data.orphan ? (
        <span className="absolute -left-2 -top-2.5 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-medium text-white shadow">
          not connected
        </span>
      ) : null}
    </div>
  );
}
