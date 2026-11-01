'use client';

import { useMemo, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { CATEGORY_HEX, CATEGORY_ORDER, SERVICES } from '@/lib/catalog';
import type { ServiceDef } from '@/lib/types';
import { ServiceIcon } from './icons';

export const DRAG_MIME = 'application/sds-service';

function matches(s: ServiceDef, q: string): boolean {
  if (!q) return true;
  const hay = `${s.name} ${s.category} ${s.summary} ${s.provides.join(' ')}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

export function Palette({
  onAdd,
  activeId,
  className,
}: {
  onAdd: (serviceId: string, e?: { clientX: number; clientY: number }) => void;
  activeId?: string | null;
  className?: string;
}) {
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const groups = useMemo(
    () =>
      CATEGORY_ORDER.map((cat) => ({ cat, items: SERVICES.filter((s) => s.category === cat && matches(s, q)) })).filter(
        (g) => g.items.length > 0,
      ),
    [q],
  );

  const onDragStart = (e: DragEvent<HTMLDivElement>, id: string) => {
    e.dataTransfer.setData(DRAG_MIME, id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onAdd(id);
    }
  };

  return (
    <aside className={`flex h-full flex-col bg-white ${className ?? 'w-64 shrink-0 border-r border-slate-200'}`}>
      <div className="border-b border-slate-200 p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Google Cloud services</div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search: cache, queue, sql..."
          className="w-full rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-sm outline-none focus:border-indigo-400 focus:bg-white"
        />
        <p className="mt-2 text-[11px] leading-snug text-slate-500">Click a service, then click the board to place it (Esc cancels). Or drag it on. Drag from a node's dot to connect.</p>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {groups.map(({ cat, items }) => {
          const isCollapsed = !q && collapsed[cat];
          return (
            <div key={cat} className="mb-2">
              <button
                type="button"
                onClick={() => setCollapsed((c) => ({ ...c, [cat]: !c[cat] }))}
                className="flex w-full items-center gap-2 px-1.5 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-800"
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: CATEGORY_HEX[cat] }} />
                {cat}
                <span className="ml-auto text-slate-400">{isCollapsed ? '+' : '-'}</span>
              </button>
              {!isCollapsed && (
                <div className="mt-1 space-y-1">
                  {items.map((s) => (
                    <div
                      key={s.id}
                      role="button"
                      tabIndex={0}
                      draggable
                      onDragStart={(e) => onDragStart(e, s.id)}
                      onClick={(e) => onAdd(s.id, e)}
                      onKeyDown={(e) => onKey(e, s.id)}
                      title={`${s.summary}\n\nTrade-off: ${s.tradeoff}`}
                      className={`flex cursor-grab items-center gap-2.5 rounded-lg border px-2 py-1.5 hover:border-slate-200 hover:bg-slate-50 active:cursor-grabbing ${activeId === s.id ? 'border-indigo-600 bg-slate-50' : 'border-transparent'}`}
                    >
                      <span
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white"
                        style={{ backgroundColor: CATEGORY_HEX[s.category] }}
                      >
                        <ServiceIcon name={s.icon} className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-slate-800">{s.name}</span>
                        <span className="block truncate text-[11px] text-slate-500">{s.summary}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {groups.length === 0 && <p className="p-3 text-sm text-slate-500">No services match "{q}".</p>}
      </div>
    </aside>
  );
}
