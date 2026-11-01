'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Problem } from '@/lib/types';
import type { Analysis } from '@/lib/analysis';
import { rubricFor } from '@/lib/rubric';
import { TIER_MAP } from '@/lib/problems';
import { fmtGB, fmtMoney, fmtMs, fmtNum } from '@/lib/format';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </section>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1">
      {items.map((t) => (
        <li key={t} className="flex gap-2 text-[13px] leading-snug text-slate-700">
          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-400" />
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------

export function BriefPanel({ problem }: { problem: Problem }) {
  const [hints, setHints] = useState(false);
  const s = problem.scale;
  const tier = TIER_MAP[problem.tier];
  return (
    <div className="p-4">
      <div className="mb-1 flex items-center gap-2">
        {problem.id === 'custom' ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">✨ Custom design</span>
        ) : (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tier.badge}`}>
            {tier.emoji} {tier.label}
          </span>
        )}
      </div>
      <h2 className="text-lg font-semibold text-slate-900">{problem.title}</h2>
      <p className="mb-4 text-sm text-slate-600">{problem.tagline}</p>

      <Section title="Functional requirements">
        <Bullets items={problem.functional} />
      </Section>
      <Section title="Non-functional requirements">
        <Bullets items={problem.nonFunctional} />
      </Section>

      <Section title="Scale assumptions">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-lg border border-slate-200 p-3 text-[13px]">
          <dt className="text-slate-500">Audience</dt>
          <dd className="text-right text-slate-800">{s.audience}</dd>
          <dt className="text-slate-500">Avg / peak load</dt>
          <dd className="text-right text-slate-800">
            {fmtNum(s.avgQps)} / {fmtNum(s.peakQps)} req/s
          </dd>
          <dt className="text-slate-500">Read share</dt>
          <dd className="text-right text-slate-800">{Math.round(s.readRatio * 100)}%</dd>
          <dt className="text-slate-500">Data</dt>
          <dd className="text-right text-slate-800">{fmtGB(s.storageGB)}</dd>
          <dt className="text-slate-500">Avg response</dt>
          <dd className="text-right text-slate-800">{s.payloadKB} KB</dd>
          <dt className="text-slate-500">Latency target (p95)</dt>
          <dd className="text-right text-slate-800">{fmtMs(s.latencyMs)}</dd>
          <dt className="text-slate-500">Availability</dt>
          <dd className="text-right text-slate-800">{s.availability}</dd>
          <dt className="text-slate-500">Reference budget</dt>
          <dd className="text-right font-medium text-slate-900">{fmtMoney(s.budgetUSD)}/mo</dd>
        </dl>
        {s.note ? <p className="mt-2 text-[12px] leading-snug text-slate-500">{s.note}</p> : null}
      </Section>

      {problem.pitfalls.length > 0 && (
      <Section title="What interviewers probe">
        <div className="mb-2 flex flex-wrap gap-1">
          {problem.tags.map((t) => (
            <span key={t} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
              {t}
            </span>
          ))}
        </div>
        <Bullets items={problem.pitfalls} />
      </Section>
      )}

      {problem.hints.length > 0 && (
      <Section title="Hints">
        {hints ? (
          <Bullets items={problem.hints} />
        ) : (
          <button type="button" onClick={() => setHints(true)} className="text-[13px] text-indigo-600 hover:underline">
            Show hints
          </button>
        )}
      </Section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------

export function CostPanel({ analysis, problem }: { analysis: Analysis; problem: Problem }) {
  const { cost } = analysis;
  const budget = problem.scale.budgetUSD;
  const ratio = cost.total / budget;
  const rows = cost.items.filter((i) => i.monthly > 0.5);
  const max = Math.max(1, ...rows.map((r) => r.monthly), cost.egress);
  const tone = ratio <= 1 ? 'text-emerald-600' : ratio <= 1.5 ? 'text-amber-600' : 'text-red-600';
  const bar = ratio <= 1 ? 'bg-emerald-500' : ratio <= 1.5 ? 'bg-amber-500' : 'bg-red-500';

  return (
    <div className="p-4">
      <div className="mb-4 rounded-xl border border-slate-200 p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Estimated monthly cost</div>
        <div className={`text-3xl font-semibold ${tone}`}>{fmtMoney(cost.total)}</div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
          <div className={`h-full ${bar}`} style={{ width: `${Math.min(100, ratio * 50)}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-slate-500">
          <span>0</span>
          <span>Reference budget {fmtMoney(budget)}</span>
          <span>{fmtMoney(budget * 2)}</span>
        </div>
      </div>

      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Where the money goes</h3>
      {rows.length === 0 && cost.egress < 0.5 && <p className="text-sm text-slate-500">Add services to see a bill.</p>}
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.nodeId}>
            <div className="flex justify-between text-[13px]">
              <span className="truncate pr-2 text-slate-700">{r.name}</span>
              <span className="font-medium text-slate-900">{fmtMoney(r.monthly)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-indigo-400" style={{ width: `${(r.monthly / max) * 100}%` }} />
            </div>
          </div>
        ))}
        {cost.egress >= 0.5 && (
          <div>
            <div className="flex justify-between text-[13px]">
              <span className="pr-2 text-slate-700">Internet egress (not via CDN)</span>
              <span className="font-medium text-slate-900">{fmtMoney(cost.egress)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-slate-400" style={{ width: `${(cost.egress / max) * 100}%` }} />
            </div>
          </div>
        )}
      </div>

      <p className="mt-5 rounded-md bg-slate-50 p-2.5 text-[11px] leading-snug text-slate-500">
        Approximate on-demand list prices (us-central1, USD), rounded for learning. Ignores committed-use discounts, most free
        tiers, support plans and taxes. Usage-based services scale with this problem's traffic. Check cloud.google.com/pricing
        before budgeting for real.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------

function Meter({ label, cap, need, format }: { label: string; cap: number; need: number; format: (n: number) => string }) {
  const ratio = need > 0 ? cap / need : 2;
  const tone = ratio >= 1.3 ? 'bg-emerald-500' : ratio >= 1 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="mb-3">
      <div className="mb-0.5 flex justify-between text-[13px]">
        <span className="text-slate-700">{label}</span>
        <span className="text-slate-900">
          {format(cap)} <span className="text-slate-400">of</span> {format(need)}
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, (ratio / 2) * 100)}%` }} />
        <div className="absolute inset-y-[-2px] left-1/2 w-px bg-slate-400" title="Required" />
      </div>
    </div>
  );
}

export function EstimatesPanel({ analysis, problem }: { analysis: Analysis; problem: Problem }) {
  const wants = new Set(rubricFor(problem).map((r) => r.req));
  const a = analysis;
  const s = problem.scale;
  const qps = (n: number) => `${fmtNum(n)}/s`;
  const rows: ReactNode[] = [];

  if (wants.has('compute-capacity'))
    rows.push(<Meter key="c" label="Front-line compute" cap={a.computeCap} need={a.computeNeed} format={qps} />);
  if (wants.has('db-read-capacity'))
    rows.push(<Meter key="dr" label="Database reads" cap={a.dbReadCap} need={a.dbReadNeed} format={qps} />);
  if (wants.has('db-write-capacity'))
    rows.push(<Meter key="dw" label="Database writes" cap={a.dbWriteCap} need={a.dbWriteNeed} format={qps} />);
  if (wants.has('cache-capacity'))
    rows.push(<Meter key="ca" label="Cache throughput" cap={a.cacheCap} need={a.cacheNeed} format={qps} />);
  if (wants.has('storage-capacity'))
    rows.push(<Meter key="st" label="Storage" cap={a.storageCap} need={a.storageNeed} format={fmtGB} />);

  const latRatio = a.latencyMs / s.latencyMs;
  const latTone = latRatio <= 1 ? 'text-emerald-600' : latRatio <= 1.5 ? 'text-amber-600' : 'text-red-600';

  return (
    <div className="p-4">
      <p className="mb-4 text-[12px] leading-snug text-slate-500">
        Live numbers from your current design. The full rubric (what is graded and why) is revealed when you submit.
      </p>

      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Load</h3>
      <div className="mb-4 grid grid-cols-2 gap-2 text-[13px]">
        <div className="rounded-lg border border-slate-200 p-2.5">
          <div className="text-slate-500">Peak load</div>
          <div className="text-base font-semibold text-slate-900">{qps(s.peakQps)}</div>
        </div>
        <div className="rounded-lg border border-slate-200 p-2.5">
          <div className="text-slate-500">Reaches origin</div>
          <div className="text-base font-semibold text-slate-900">{qps(a.originPeak)}</div>
          <div className="text-[11px] text-slate-500">
            {a.cdnOffload > 0 ? `CDN offloads ${Math.round(a.cdnOffload * 100)}%` : 'no CDN offload'}
          </div>
        </div>
        <div className="col-span-2 rounded-lg border border-slate-200 p-2.5">
          <div className="text-slate-500">Reads absorbed by cache</div>
          <div className="text-base font-semibold text-slate-900">
            {a.cacheLinked ? `${Math.round(a.cacheHitEff * 100)}%` : 'No cache connected to compute'}
          </div>
        </div>
      </div>

      {rows.length > 0 && (
        <>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Capacity vs need</h3>
          {rows}
          <p className="mb-4 text-[11px] text-slate-500">The tick marks the required level. Aim for the green zone (1.3x or more).</p>
        </>
      )}

      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Latency (synchronous path)</h3>
      <div className="mb-4 rounded-lg border border-slate-200 p-3">
        <div className="flex items-baseline justify-between">
          <span className={`text-2xl font-semibold ${latTone}`}>{a.latencyMs > 0 ? fmtMs(a.latencyMs) : 'n/a'}</span>
          <span className="text-[12px] text-slate-500">target {fmtMs(s.latencyMs)}</span>
        </div>
        {a.latencyParts.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-[12px] text-slate-600">
            {a.latencyParts.map((p, i) => (
              <li key={`${p.label}-${i}`} className="flex justify-between">
                <span>{p.label}</span>
                <span>{fmtMs(p.ms)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11px] text-slate-500">Work behind a queue is not on this path.</p>
      </div>

      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Cost</h3>
      <div className="text-sm text-slate-800">
        {fmtMoney(a.cost.total)}/mo vs {fmtMoney(s.budgetUSD)} reference budget
      </div>
    </div>
  );
}
