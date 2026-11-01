'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Design, Problem } from '@/lib/types';
import { loadAt, simulateStep } from '@/lib/simulate';
import type { LoadSpec, NodeSim, Pattern, SimFrame } from '@/lib/simulate';
import { SERVICE_MAP } from '@/lib/catalog';
import { fmtMoney, fmtMs, fmtNum } from '@/lib/format';

const HISTORY = 90;

function Spark({ values, color, max, label, value }: { values: number[]; color: string; max?: number; label: string; value: string }) {
  const top = max ?? Math.max(1e-9, ...values) * 1.1;
  const w = 300;
  const h = 44;
  const pts = values
    .map((v, i) => `${(i / Math.max(1, HISTORY - 1)) * w},${h - Math.min(1, v / top) * (h - 4) - 2}`)
    .join(' ');
  return (
    <div className="mb-2 rounded-lg border border-slate-200 p-2">
      <div className="flex justify-between text-[12px]">
        <span className="text-slate-500">{label}</span>
        <span className="font-semibold text-slate-900">{value}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-11 w-full" preserveAspectRatio="none">
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

function Bar({ value, label }: { value: number | undefined; label: string }) {
  if (value === undefined) return <div className="h-4 text-[10px] text-slate-400">{label} n/a</div>;
  const tone = value >= 90 ? 'bg-red-500' : value >= 70 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-7 text-[10px] uppercase text-slate-500">{label}</span>
      <div className="h-1.5 flex-1 rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className="w-9 text-right text-[11px] text-slate-700">{Math.round(value)}%</span>
    </div>
  );
}

const logPos = (v: number, min: number, max: number) => Math.round((1000 * (Math.log(Math.max(v, min)) - Math.log(min))) / (Math.log(max) - Math.log(min)));
const fromLog = (pos: number, min: number, max: number) => {
  const raw = Math.exp(Math.log(min) + (pos / 1000) * (Math.log(max) - Math.log(min)));
  const unit = Math.pow(10, Math.max(0, Math.floor(Math.log10(raw)) - 1));
  return Math.min(max, Math.max(min, Math.round(raw / unit) * unit));
};

export function Playground({
  design,
  problem,
  onFrame,
}: {
  design: Design;
  problem: Problem;
  onFrame: (nodes: Record<string, NodeSim> | null) => void;
}) {
  const s = problem.scale;
  const [load, setLoad] = useState<LoadSpec>({ rps: s.avgQps, readRatio: s.readRatio, payloadKB: s.payloadKB, pattern: 'steady', burst: false });
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [hist, setHist] = useState<SimFrame[]>([]);

  const designRef = useRef(design);
  designRef.current = design;
  const loadRef = useRef(load);
  loadRef.current = load;
  const tRef = useRef(0);
  const backlogRef = useRef<Record<string, number>>({});
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const step = useCallback(
    (dt: number) => {
      tRef.current += dt;
      const l = loadRef.current;
      const rps = loadAt(l, tRef.current, Math.random());
      const res = simulateStep(designRef.current, problem, l, tRef.current, rps, backlogRef.current, dt);
      backlogRef.current = res.backlog;
      setHist((h) => [...h.slice(-(HISTORY - 1)), res.frame]);
      onFrame(res.frame.nodes);
    },
    [problem, onFrame],
  );

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => step(0.5 * speedRef.current), 500);
    return () => window.clearInterval(id);
  }, [running, step]);

  // when paused, still refresh the numbers as the design or load changes
  useEffect(() => {
    if (!running) step(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design, load, running]);

  useEffect(() => () => onFrame(null), [onFrame]);

  const f = hist[hist.length - 1];
  const rpsMax = Math.max(100, s.peakQps * 5);
  const set = (patch: Partial<LoadSpec>) => setLoad((l) => ({ ...l, ...patch }));
  const reset = () => {
    backlogRef.current = {};
    tRef.current = 0;
    setHist([]);
  };

  const rows = f
    ? Object.entries(f.nodes)
        .map(([id, n]) => ({ id, n, def: design.nodes.find((d) => d.id === id) }))
        .filter((r) => r.def && (r.n.cpu !== undefined || r.n.backlog !== undefined))
    : [];

  const errTone = !f ? '' : f.errorRate > 0.05 ? 'text-red-600' : f.errorRate > 0.005 ? 'text-amber-600' : 'text-emerald-600';
  const latTone = !f ? '' : f.p95 <= s.latencyMs ? 'text-emerald-600' : f.p95 <= s.latencyMs * 1.5 ? 'text-amber-600' : 'text-red-600';
  const costTone = !f ? '' : f.monthly <= s.budgetUSD ? 'text-emerald-600' : f.monthly <= s.budgetUSD * 1.5 ? 'text-amber-600' : 'text-red-600';

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setRunning((r) => !r)}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700"
        >
          {running ? 'Pause' : 'Run'}
        </button>
        <button type="button" onClick={reset} className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
          Reset
        </button>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="ml-auto rounded-md border border-slate-200 px-2 py-1.5 text-sm">
          <option value={1}>1x</option>
          <option value={2}>2x</option>
          <option value={4}>4x</option>
        </select>
      </div>

      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Client requests</h3>
      <div className="mb-4 rounded-lg border border-slate-200 p-3">
        <div className="mb-1 flex justify-between text-[12px]">
          <span className="text-slate-600">Requests per second</span>
          <span className="font-semibold text-slate-900">{fmtNum(load.rps)}/s</span>
        </div>
        <input
          type="range"
          min={0}
          max={1000}
          value={logPos(load.rps, 1, rpsMax)}
          onChange={(e) => set({ rps: fromLog(Number(e.target.value), 1, rpsMax) })}
          className="mb-1 h-1.5 w-full accent-indigo-600"
        />
        <div className="mb-3 flex gap-1.5">
          <button type="button" onClick={() => set({ rps: s.avgQps })} className="rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50">
            Average
          </button>
          <button type="button" onClick={() => set({ rps: s.peakQps })} className="rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50">
            Peak
          </button>
          <button type="button" onClick={() => set({ rps: s.peakQps * 3 })} className="rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50">
            3x peak
          </button>
          <button
            type="button"
            onClick={() => set({ burst: !load.burst })}
            className={`ml-auto rounded px-2 py-0.5 text-[11px] font-medium ${load.burst ? 'bg-red-600 text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'}`}
          >
            {load.burst ? 'Burst x5 ON' : 'Burst x5'}
          </button>
        </div>

        <div className="mb-1 flex justify-between text-[12px]">
          <span className="text-slate-600">Reads (vs writes)</span>
          <span className="font-semibold text-slate-900">{Math.round(load.readRatio * 100)}% reads</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(load.readRatio * 100)}
          onChange={(e) => set({ readRatio: Number(e.target.value) / 100 })}
          className="mb-3 h-1.5 w-full accent-indigo-600"
        />

        <div className="mb-1 flex justify-between text-[12px]">
          <span className="text-slate-600">Response size</span>
          <span className="font-semibold text-slate-900">{load.payloadKB} KB</span>
        </div>
        <input
          type="range"
          min={0}
          max={1000}
          value={logPos(load.payloadKB, 0.1, 5000)}
          onChange={(e) => set({ payloadKB: +fromLog(Number(e.target.value), 0.1, 5000).toFixed(1) })}
          className="mb-3 h-1.5 w-full accent-indigo-600"
        />

        <label className="mb-1 block text-[12px] text-slate-600">Traffic pattern</label>
        <select value={load.pattern} onChange={(e) => set({ pattern: e.target.value as Pattern })} className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm">
          <option value="steady">Steady</option>
          <option value="diurnal">Daily wave (60 s cycle)</option>
          <option value="spike">Spikes (4x for 8 s every 30 s)</option>
        </select>
      </div>

      {f && (
        <>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Right now</h3>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-slate-200 p-2.5">
              <div className="text-[11px] text-slate-500">Incoming</div>
              <div className="text-lg font-semibold text-slate-900">{fmtNum(f.rps)}/s</div>
              <div className="text-[11px] text-slate-500">{fmtNum(f.originRps)}/s reach origin</div>
            </div>
            <div className="rounded-lg border border-slate-200 p-2.5">
              <div className="text-[11px] text-slate-500">Errors</div>
              <div className={`text-lg font-semibold ${errTone}`}>{(f.errorRate * 100).toFixed(f.errorRate < 0.01 ? 2 : 1)}%</div>
              <div className="text-[11px] text-slate-500">dropped / failed</div>
            </div>
            <div className="rounded-lg border border-slate-200 p-2.5">
              <div className="text-[11px] text-slate-500">p95 latency</div>
              <div className={`text-lg font-semibold ${latTone}`}>{fmtMs(f.p95)}</div>
              <div className="text-[11px] text-slate-500">target {fmtMs(s.latencyMs)}</div>
            </div>
            <div className="rounded-lg border border-slate-200 p-2.5">
              <div className="text-[11px] text-slate-500">Cache absorbing</div>
              <div className="text-lg font-semibold text-slate-900">{Math.round(f.cacheHit * 100)}%</div>
              <div className="text-[11px] text-slate-500">of reads</div>
            </div>
          </div>

          <div className="mb-3 rounded-lg border border-slate-200 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Estimated cost at this load</div>
            <div className="flex items-baseline gap-2">
              <span className={`text-2xl font-semibold ${costTone}`}>{fmtMoney(f.monthly)}</span>
              <span className="text-[12px] text-slate-500">per month if sustained</span>
            </div>
            <div className="mt-1 flex justify-between text-[12px] text-slate-600">
              <span>{f.perHour < 10 ? `$${f.perHour.toFixed(2)}` : fmtMoney(f.perHour)} per hour</span>
              <span>${f.perMillion < 1 ? f.perMillion.toFixed(3) : f.perMillion.toFixed(2)} per 1M requests</span>
              <span>budget {fmtMoney(s.budgetUSD)}</span>
            </div>
          </div>

          {f.bottleneck && (
            <div className="mb-3 rounded-lg bg-amber-50 p-2.5 text-[12px] text-amber-700">
              Bottleneck: <span className="font-semibold">{f.bottleneck}</span> is running hot. Scale it up on the canvas and watch the numbers react.
            </div>
          )}

          <Spark values={hist.map((h) => h.rps)} color="#6366f1" label="Requests/s" value={`${fmtNum(f.rps)}/s`} />
          <Spark values={hist.map((h) => h.maxCpu)} color="#f59e0b" max={100} label="Hottest service CPU" value={`${Math.round(f.maxCpu)}%`} />
          <Spark values={hist.map((h) => h.p95)} color="#10b981" label="p95 latency" value={fmtMs(f.p95)} />
          <Spark values={hist.map((h) => h.errorRate * 100)} color="#ef4444" max={Math.max(5, ...hist.map((h) => h.errorRate * 100))} label="Error rate" value={`${(f.errorRate * 100).toFixed(1)}%`} />
          <Spark values={hist.map((h) => h.monthly)} color="#8b5cf6" label="Projected monthly cost" value={fmtMoney(f.monthly)} />

          <h3 className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Services (live)</h3>
          <div className="space-y-2.5">
            {rows.map(({ id, n, def }) => {
              const name = def?.label || SERVICE_MAP[def?.serviceId ?? '']?.name || id;
              return (
                <div key={id} className="rounded-lg border border-slate-200 p-2">
                  <div className="mb-1 flex items-center justify-between text-[12px]">
                    <span className="truncate pr-2 font-medium text-slate-800">{name}</span>
                    <span className="text-slate-500">{fmtNum(n.rps)}/s</span>
                  </div>
                  <Bar value={n.cpu} label="CPU" />
                  <Bar value={n.mem} label="Mem" />
                  {n.detail && <div className="mt-0.5 text-[11px] text-slate-500">{n.detail}</div>}
                </div>
              );
            })}
          </div>
        </>
      )}

      <p className="mt-4 rounded-md bg-slate-50 p-2.5 text-[11px] leading-snug text-slate-500">
        A teaching model built on the same capacity numbers as the scorer: CPU and memory are estimates, Cloud Run and Functions autoscale
        between min and max instances, and queues build a backlog when workers cannot keep up. Cost uses the usage-based prices at the
        current request rate. Edit services on the canvas while it runs.
      </p>
    </div>
  );
}
