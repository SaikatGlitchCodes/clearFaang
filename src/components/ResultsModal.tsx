'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Design, Problem, ScoreCategory } from '@/lib/types';
import { CATEGORY_LABEL, TIER_THRESHOLD, evaluate } from '@/lib/evaluate';
import type { ReqResult, Suggestion } from '@/lib/evaluate';
import { TIER_MAP } from '@/lib/problems';
import { fmtGB, fmtMoney, fmtMs, fmtNum } from '@/lib/format';
import type { Submission } from '@/lib/storage';

interface Props {
  problem: Problem;
  design: Design;
  history: Submission[];
  latestId: string | null;
  hasUnsaved: boolean;
  onClose: () => void;
  onApply: (s: Suggestion) => void;
  onSaveAttempt: () => void;
  onRestore: (s: Submission) => void;
  onReference: () => void;
  onNotes: (id: string, notes: string) => void;
}

const ORDER: ScoreCategory[] = ['scalability', 'reliability', 'performance', 'fit'];

function ScoreRing({ score, passed }: { score: number; passed: boolean }) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const color = passed ? '#059669' : score >= 50 ? '#d97706' : '#dc2626';
  return (
    <svg viewBox="0 0 110 110" className="h-28 w-28 shrink-0">
      <circle cx="55" cy="55" r={r} fill="none" stroke="#e2e8f0" strokeWidth="9" />
      <circle
        cx="55"
        cy="55"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="9"
        strokeLinecap="round"
        strokeDasharray={`${(Math.max(0, Math.min(100, score)) / 100) * c} ${c}`}
        transform="rotate(-90 55 55)"
      />
      <text x="55" y="53" textAnchor="middle" className="fill-slate-900" style={{ fontSize: 28, fontWeight: 700 }}>
        {Math.round(score)}
      </text>
      <text x="55" y="72" textAnchor="middle" className="fill-slate-500" style={{ fontSize: 11 }}>
        out of 100
      </text>
    </svg>
  );
}

function Mark({ score }: { score: number }) {
  if (score >= 0.85) return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700">✓</span>;
  if (score >= 0.4) return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-100 text-xs font-bold text-amber-700">~</span>;
  return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-100 text-xs font-bold text-red-700">✕</span>;
}

function CategoryBar({ label, value }: { label: string; value: number | null }) {
  if (value === null) {
    return (
      <div className="mb-2">
        <div className="flex justify-between text-[13px] text-slate-400">
          <span>{label}</span>
          <span>n/a</span>
        </div>
        <div className="h-2 rounded-full bg-slate-100" />
      </div>
    );
  }
  const tone = value >= 80 ? 'bg-emerald-500' : value >= 60 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="mb-2">
      <div className="flex justify-between text-[13px]">
        <span className="text-slate-700">{label}</span>
        <span className="font-medium text-slate-900">{Math.round(value)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full ${tone}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function ReqRow({ r }: { r: ReqResult }) {
  return (
    <li className="flex gap-3 py-2">
      <div className="pt-0.5">
        <Mark score={r.score} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-slate-900">{r.label}</span>
          {r.bonus && <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">bonus</span>}
          <span className="text-[11px] text-slate-400">weight {r.weight}</span>
        </div>
        <p className="text-[12px] leading-snug text-slate-600">{r.detail}</p>
        {r.note ? <p className="mt-0.5 text-[12px] leading-snug text-indigo-700">{r.note}</p> : null}
        {r.score < 0.85 && (
          <details className="mt-0.5">
            <summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-800">Why it matters</summary>
            <p className="mt-0.5 text-[12px] leading-snug text-slate-600">{r.why}</p>
          </details>
        )}
      </div>
    </li>
  );
}

export function ResultsModal(props: Props) {
  const { problem, design, history, latestId, hasUnsaved, onClose } = props;
  const ev = useMemo(() => evaluate(design, problem), [design, problem]);
  const latest = history.find((h) => h.id === latestId);
  const [notes, setNotes] = useState(latest?.notes ?? '');
  const tier = TIER_MAP[problem.tier];
  const a = ev.analysis;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const required = ev.suggestions.filter((s) => !s.optional);
  const optional = ev.suggestions.filter((s) => s.optional);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 sm:p-8" onClick={onClose}>
      <div className="w-full max-w-4xl rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div className="flex items-start gap-5 border-b border-slate-200 p-6">
          <ScoreRing score={ev.overall} passed={ev.passed} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold text-slate-900">{problem.title}</h2>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tier.badge}`}>
                {tier.emoji} {tier.label}
              </span>
            </div>
            <p className="mt-1 text-[15px] text-slate-700">
              Grade <span className="font-semibold">{ev.grade}</span>.{' '}
              {ev.passed ? (
                <span className="font-medium text-emerald-700">Meets the bar for this level ({TIER_THRESHOLD[problem.tier]}+).</span>
              ) : (
                <span className="font-medium text-amber-700">
                  Below the bar for this level ({TIER_THRESHOLD[problem.tier]}+). Work through the improvements below.
                </span>
              )}
            </p>
            <p className="mt-1 text-[13px] text-slate-500">{ev.costDetail}</p>
            {ev.warnings.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {ev.warnings.map((w) => (
                  <li key={w} className="text-[12px] text-amber-700">
                    ! {w}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="grid gap-6 p-6 md:grid-cols-3">
          {/* left column */}
          <div className="md:col-span-1">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Score breakdown</h3>
            {ORDER.map((c) => (
              <CategoryBar key={c} label={CATEGORY_LABEL[c]} value={ev.categories[c]} />
            ))}
            <CategoryBar label={CATEGORY_LABEL.cost} value={ev.categories.cost} />

            <h3 className="mb-2 mt-6 text-[11px] font-semibold uppercase tracking-wide text-slate-500">The numbers</h3>
            <dl className="space-y-1.5 text-[13px]">
              <div className="flex justify-between">
                <dt className="text-slate-500">Monthly cost</dt>
                <dd className="font-medium text-slate-900">
                  {fmtMoney(a.cost.total)} <span className="text-slate-400">/ {fmtMoney(problem.scale.budgetUSD)}</span>
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Peak to origin</dt>
                <dd className="text-slate-900">{fmtNum(a.originPeak)}/s</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Compute capacity</dt>
                <dd className="text-slate-900">
                  {fmtNum(a.computeCap)}/s <span className="text-slate-400">vs {fmtNum(a.computeNeed)}</span>
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">DB reads / writes</dt>
                <dd className="text-slate-900">
                  {fmtNum(a.dbReadCap)} / {fmtNum(a.dbWriteCap)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Storage</dt>
                <dd className="text-slate-900">
                  {fmtGB(a.storageCap)} <span className="text-slate-400">vs {fmtGB(a.storageNeed)}</span>
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Est. p95 latency</dt>
                <dd className="text-slate-900">
                  {fmtMs(a.latencyMs)} <span className="text-slate-400">vs {fmtMs(problem.scale.latencyMs)}</span>
                </dd>
              </div>
            </dl>

            <h3 className="mb-2 mt-6 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Top cost drivers</h3>
            <ul className="space-y-1 text-[13px]">
              {a.cost.items
                .filter((i) => i.monthly > 0.5)
                .slice(0, 6)
                .map((i) => (
                  <li key={i.nodeId} className="flex justify-between">
                    <span className="truncate pr-2 text-slate-700">{i.name}</span>
                    <span className="text-slate-900">{fmtMoney(i.monthly)}</span>
                  </li>
                ))}
              {a.cost.egress >= 0.5 && (
                <li className="flex justify-between">
                  <span className="pr-2 text-slate-700">Internet egress</span>
                  <span className="text-slate-900">{fmtMoney(a.cost.egress)}</span>
                </li>
              )}
            </ul>
          </div>

          {/* right column */}
          <div className="md:col-span-2">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">How to improve</h3>
            {required.length === 0 && optional.length === 0 ? (
              <p className="mb-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
                Nothing left to fix. Try tuning configs to hit the same score for less money.
              </p>
            ) : (
              <ul className="mb-4 divide-y divide-slate-100 rounded-lg border border-slate-200">
                {[...required, ...optional].map((s) => (
                  <li key={s.title} className="flex items-start gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-medium text-slate-900">{s.title}</span>
                        {s.optional && <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">bonus</span>}
                      </div>
                      <p className="text-[12px] leading-snug text-slate-500">
                        Fixes: {s.reqLabel}. {s.detail}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className={`text-[12px] font-medium ${s.costDelta > 0 ? 'text-slate-700' : 'text-emerald-700'}`}>
                        {s.costDelta >= 0 ? '+' : '-'}
                        {fmtMoney(Math.abs(s.costDelta))}/mo
                      </div>
                      <button
                        type="button"
                        onClick={() => props.onApply(s)}
                        className="mt-1 rounded-md bg-indigo-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-indigo-700"
                      >
                        Apply
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Rubric</h3>
            {ORDER.map((c) => {
              const items = ev.reqs.filter((r) => r.category === c);
              if (!items.length) return null;
              return (
                <div key={c} className="mb-3">
                  <div className="text-[12px] font-semibold text-slate-700">{CATEGORY_LABEL[c]}</div>
                  <ul className="divide-y divide-slate-100">
                    {items.map((r) => (
                      <ReqRow key={r.id} r={r} />
                    ))}
                  </ul>
                </div>
              );
            })}

            <h3 className="mb-1 mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Your design notes</h3>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => latestId && props.onNotes(latestId, notes)}
              placeholder="Explain your trade-offs: API shape, schema, consistency model, failure handling. (Saved with this attempt, not scored.)"
              rows={4}
              className="w-full rounded-lg border border-slate-200 p-2.5 text-sm outline-none focus:border-indigo-400"
            />
          </div>
        </div>

        {/* history */}
        {history.length > 0 && (
          <div className="border-t border-slate-200 px-6 py-4">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Attempt history</h3>
            <ul className="space-y-1">
              {history.map((h) => (
                <li key={h.id} className="flex items-center gap-3 text-[13px]">
                  <span className="w-40 text-slate-500">{new Date(h.at).toLocaleString()}</span>
                  <span className="w-20 font-medium text-slate-900">
                    {Math.round(h.overall)} ({h.grade})
                  </span>
                  <span className="w-24 text-slate-600">{fmtMoney(h.cost)}/mo</span>
                  <button type="button" onClick={() => props.onRestore(h)} className="text-indigo-600 hover:underline">
                    Restore this design
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* footer */}
        <div className="flex flex-wrap items-center gap-3 rounded-b-2xl border-t border-slate-200 bg-slate-50 px-6 py-4">
          <button type="button" onClick={onClose} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
            Back to canvas
          </button>
          {hasUnsaved && (
            <button
              type="button"
              onClick={props.onSaveAttempt}
              className="rounded-md border border-indigo-300 bg-white px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50"
            >
              Save as new attempt
            </button>
          )}
          <button
            type="button"
            onClick={props.onReference}
            className="ml-auto rounded-md border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
            title="Replaces the canvas. Your current design is kept in the attempt history."
          >
            Show a suggested architecture
          </button>
        </div>
      </div>
    </div>
  );
}
