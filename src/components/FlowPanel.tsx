'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Problem } from '@/lib/types';
import type { Analysis } from '@/lib/analysis';
import { explain } from '@/lib/explain';
import type { FlowPath, Tone } from '@/lib/explain';

const DOT: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
  info: 'bg-slate-400',
};
const TEXT: Record<Tone, string> = {
  ok: 'text-emerald-700',
  warn: 'text-amber-700',
  bad: 'text-red-700',
  info: 'text-slate-500',
};
const VERDICT: Record<Tone, string> = {
  ok: 'Good fit',
  warn: 'Needs attention',
  bad: 'Problem',
  info: 'Supporting',
};

const fmt = (n: number) => (n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(n >= 10 ? 0 : 1));

function PathView({
  path,
  tracing,
  onTrace,
  onHover,
}: {
  path: FlowPath;
  tracing: boolean;
  onTrace: () => void;
  onHover: (ids: string[] | null) => void;
}) {
  return (
    <section className="mb-5">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{path.title}</h3>
        <button
          type="button"
          onClick={onTrace}
          className={`rounded px-2 py-0.5 text-[11px] font-medium ${tracing ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'}`}
        >
          {tracing ? 'Tracing on canvas' : 'Trace on canvas'}
        </button>
      </div>
      <p className="mb-2 text-[12px] text-slate-500">{path.summary}</p>
      <ol className="relative">
        {path.hops.map((h, i) => (
          <li
            key={`${h.title}-${i}`}
            className="relative pb-3 pl-8"
            onMouseEnter={() => h.nodeIds.length && onHover(h.nodeIds)}
            onMouseLeave={() => onHover(null)}
          >
            {i < path.hops.length - 1 && <span className="absolute left-[11px] top-6 h-[calc(100%-18px)] w-px bg-slate-200" />}
            <span className={`absolute left-0 top-0.5 flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold text-white ${DOT[h.tone]}`}>
              {i + 1}
            </span>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[13px] font-medium text-slate-900">{h.title}</span>
              {h.rps !== undefined && <span className="shrink-0 text-[11px] text-slate-500">{fmt(h.rps)} req/s</span>}
            </div>
            <p className="text-[12px] leading-snug text-slate-600">{h.note}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function FlowPanel({
  analysis,
  problem,
  onHighlight,
}: {
  analysis: Analysis;
  problem: Problem;
  onHighlight: (ids: string[]) => void;
}) {
  const ex = useMemo(() => explain(problem, analysis), [problem, analysis]);
  const [trace, setTrace] = useState<string | null>(null);
  const [view, setView] = useState<'flow' | 'why'>('flow');

  const traceIds = useMemo(() => {
    const p = ex.paths.find((x) => x.id === trace);
    return p ? Array.from(new Set(p.hops.flatMap((h) => h.nodeIds))) : [];
  }, [ex, trace]);

  useEffect(() => {
    onHighlight(traceIds);
  }, [traceIds, onHighlight]);
  useEffect(() => () => onHighlight([]), [onHighlight]);

  return (
    <div className="p-4">
      <div className="mb-4 flex rounded-lg border border-slate-200 p-0.5 text-sm">
        {(['flow', 'why'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`flex-1 rounded-md px-3 py-1 font-medium ${view === v ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            {v === 'flow' ? 'Data flow' : 'Why these services'}
          </button>
        ))}
      </div>

      {view === 'flow' ? (
        <>
          <p className="mb-4 text-[12px] leading-snug text-slate-500">
            Follow a request through your design at peak load. Hover a step to light it up on the canvas. Green means it handles the load
            with headroom, amber is tight or missing, red will fail.
          </p>
          {ex.paths.map((p) => (
            <PathView
              key={p.id}
              path={p}
              tracing={trace === p.id}
              onTrace={() => setTrace((t) => (t === p.id ? null : p.id))}
              onHover={(ids) => onHighlight(ids ?? traceIds)}
            />
          ))}
        </>
      ) : (
        <>
          <p className="mb-4 text-[12px] leading-snug text-slate-500">
            Each service in your design, judged on the live numbers. Problems are listed first.
          </p>
          {ex.services.length === 0 && <p className="text-sm text-slate-500">Add services to see them explained.</p>}
          <div className="space-y-3">
            {ex.services.map((s) => (
              <div
                key={s.nodeId}
                className="rounded-lg border border-slate-200 p-3"
                onMouseEnter={() => onHighlight([s.nodeId])}
                onMouseLeave={() => onHighlight(traceIds)}
              >
                <div className="mb-0.5 flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold text-slate-900">{s.name}</span>
                  <span className={`flex items-center gap-1 text-[11px] font-medium ${TEXT[s.verdict]}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${DOT[s.verdict]}`} />
                    {VERDICT[s.verdict]}
                  </span>
                </div>
                <p className="mb-1.5 text-[12px] text-slate-500">{s.role}</p>
                <ul className="space-y-1">
                  {s.reasons.map((r, i) => (
                    <li key={i} className="flex gap-2 text-[12px] leading-snug text-slate-700">
                      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[r.tone]}`} />
                      <span>{r.text}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-[11px] italic leading-snug text-slate-500">Trade-off: {s.tradeoff}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
