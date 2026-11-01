'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { CATEGORY_HEX, SERVICE_MAP } from '@/lib/catalog';
import { ServiceIcon } from './icons';

/**
 * "Pick, then place": clicking a service in the palette attaches it to the cursor;
 * the next click on the board drops it there. Esc cancels. Dragging from the palette still works.
 */
export function useServicePlacement(place: (serviceId: string, clientX: number, clientY: number) => void) {
  const [placing, setPlacing] = useState<string | null>(null);
  const [pos, setPos] = useState({ x: -1, y: -1 });

  const pick = useCallback((id: string, e?: { clientX: number; clientY: number }) => {
    setPlacing((cur) => (cur === id ? null : id));
    if (e && e.clientX > 0) setPos({ x: e.clientX, y: e.clientY });
  }, []);

  const cancel = useCallback(() => setPlacing(null), []);

  useEffect(() => {
    if (!placing) return;
    const move = (e: MouseEvent) => setPos({ x: e.clientX, y: e.clientY });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPlacing(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('keydown', key);
    };
  }, [placing]);

  /** Call from the canvas click handlers. Returns true when the click was used to place the service. */
  const tryPlace = useCallback(
    (e: ReactMouseEvent | MouseEvent) => {
      if (!placing) return false;
      place(placing, e.clientX, e.clientY);
      setPlacing(null);
      return true;
    },
    [placing, place],
  );

  const def = placing ? SERVICE_MAP[placing] : null;

  const ghost: ReactNode =
    def && pos.x >= 0 ? (
      <div
        className="pointer-events-none fixed z-50 flex w-[200px] items-center gap-2.5 rounded-xl border-2 border-dashed bg-white/90 px-3 py-2.5 shadow-lg"
        style={{ left: pos.x, top: pos.y, transform: 'translate(-50%, -50%)', borderColor: CATEGORY_HEX[def.category] }}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white" style={{ backgroundColor: CATEGORY_HEX[def.category] }}>
          <ServiceIcon name={def.icon} className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold leading-tight text-slate-900">{def.name}</span>
          <span className="block truncate text-[11px] leading-tight text-slate-500">{def.category}</span>
        </span>
      </div>
    ) : null;

  const hint: ReactNode = def ? (
    <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-slate-900 px-3 py-1 text-[12px] text-white shadow">
      Click on the board to place {def.name} · Esc to cancel
    </div>
  ) : null;

  return { placing, pick, cancel, tryPlace, ghost, hint };
}
