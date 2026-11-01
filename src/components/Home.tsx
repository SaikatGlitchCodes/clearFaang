'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PROBLEMS, TIERS } from '@/lib/problems';
import { Brand } from './Brand';
import { MindMap } from './MindMap';
import { ThemeToggle } from './ThemeToggle';
import { bestScores, loadStudied, setStudied } from '@/lib/storage';
import { fmtGB, fmtMoney, fmtNum } from '@/lib/format';
import type { Problem, Tier } from '@/lib/types';

function ProblemCard({
  problem,
  best,
  studied,
  onToggle,
}: {
  problem: Problem;
  best: number | undefined;
  studied: boolean;
  onToggle: () => void;
}) {
  const s = problem.scale;
  const tier = TIERS.find((t) => t.id === problem.tier);
  const badge =
    best === undefined
      ? null
      : best >= 80
        ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
        : best >= 60
          ? 'bg-amber-50 text-amber-700 ring-amber-200'
          : 'bg-red-50 text-red-700 ring-red-200';

  return (
    <div className={`group relative flex flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow-md ${tier?.ring ?? ''}`}>
      <Link href={`/design/${problem.id}`} className="absolute inset-0 rounded-xl" aria-label={`Open ${problem.title}`} />
      <div className="mb-1 flex items-start justify-between gap-2">
        <h3 className="text-[15px] font-semibold leading-snug text-slate-900">{problem.title}</h3>
        {badge && best !== undefined && (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${badge}`}>Best {Math.round(best)}</span>
        )}
      </div>
      <p className="mb-3 text-[13px] leading-snug text-slate-600">{problem.tagline}</p>
      <div className="mb-3 flex flex-wrap gap-1">
        {problem.tags.slice(0, 4).map((t) => (
          <span key={t} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
            {t}
          </span>
        ))}
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 pt-1 text-[12px] text-slate-500">
        <span>
          {fmtNum(s.peakQps)} peak req/s · {fmtGB(s.storageGB)} · ~{fmtMoney(s.budgetUSD)}/mo
        </span>
        <button
          type="button"
          onClick={onToggle}
          title={studied ? 'Marked as studied (click to undo)' : 'Mark as studied'}
          className={`relative z-10 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
            studied ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-500 ring-slate-300 hover:bg-slate-50'
          }`}
        >
          {studied ? '✓ Studied' : 'Mark studied'}
        </button>
      </div>
    </div>
  );
}

export default function Home() {
  const [view, setView] = useState<'map' | 'list'>('map');
  const [filter, setFilter] = useState<Tier | 'all'>('all');
  const [q, setQ] = useState('');
  const [studied, setStudiedState] = useState<Record<string, boolean>>({});
  const [best, setBest] = useState<Record<string, number>>({});

  useEffect(() => {
    setStudiedState(loadStudied());
    setBest(bestScores(PROBLEMS.map((p) => p.id)));
  }, []);

  const matches = (p: Problem) => {
    if (!q.trim()) return true;
    const hay = `${p.title} ${p.tagline} ${p.tags.join(' ')}`.toLowerCase();
    return q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((t) => hay.includes(t));
  };

  const attempted = Object.keys(best).length;
  const studiedCount = PROBLEMS.filter((p) => studied[p.id]).length;
  const avgBest = useMemo(() => {
    const v = Object.values(best);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  }, [best]);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <Brand />
          <div className="flex items-center gap-4">
            <div className="hidden gap-4 text-[12px] text-slate-500 sm:flex">
              <span>
                <b className="text-slate-900">{studiedCount}</b> studied
              </span>
              <span>
                <b className="text-slate-900">{attempted}</b> attempted
              </span>
              <span>
                avg best <b className="text-slate-900">{avgBest === null ? '-' : avgBest}</b>
              </span>
            </div>
            <Link href="/playground" className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800">
              AI Playground
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6">
        <section className="py-10 text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">Master system design, one problem at a time.</h1>
          <p className="mx-auto mt-3 max-w-xl text-[15px] leading-relaxed text-slate-600">
            Pick a topic, drag Google Cloud services onto the board, watch the bill and capacity move, then get scored.
          </p>

          <div className="mx-auto mt-6 flex max-w-xl items-center gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search topics or skills (caching, consensus...)"
              className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400"
            />
            <div className="inline-flex shrink-0 rounded-lg border border-slate-200 bg-white p-0.5 text-sm">
              {(['map', 'list'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`rounded-md px-3 py-1.5 ${view === v ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                >
                  {v === 'map' ? 'Mind map' : 'List'}
                </button>
              ))}
            </div>
          </div>
        </section>

        {view === 'map' ? (
          <>
            <MindMap best={best} studied={studied} match={matches} />
            <p className="mt-2 text-center text-[12px] text-slate-500">Rearrange the map however you like; it remembers your layout. Click a topic to open its design board. Numbers are your best scores.</p>
            <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {TIERS.map((t) => (
                <div key={t.id} className="rounded-xl border border-slate-200 bg-white p-3.5">
                  <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-slate-900">
                    <span className={`h-2 w-2 rounded-full ${t.dot}`} />
                    {t.label.split(' / ')[0]}
                  </div>
                  <p className="mb-2 text-[12px] leading-snug text-slate-500">{t.blurb}</p>
                  <div className="flex flex-wrap gap-1">
                    {t.checks.map((c) => (
                      <span key={c} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="mb-6 inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
              {([{ id: 'all', label: 'All levels' }, ...TIERS.map((t) => ({ id: t.id, label: `${t.emoji} ${t.label.split(' / ')[0]}` }))] as { id: Tier | 'all'; label: string }[]).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setFilter(t.id)}
                  className={`rounded-md px-3 py-1.5 text-sm ${filter === t.id ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {TIERS.filter((t) => filter === 'all' || filter === t.id).map((tier) => {
              const items = PROBLEMS.filter((p) => p.tier === tier.id && matches(p));
              if (!items.length) return null;
              return (
                <section key={tier.id} className="mb-10">
                  <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h2 className="text-lg font-semibold text-slate-900">
                      {tier.emoji} {tier.label}
                    </h2>
                    <span className="text-sm text-slate-500">{tier.blurb}</span>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {items.map((p) => (
                      <ProblemCard
                        key={p.id}
                        problem={p}
                        best={best[p.id]}
                        studied={!!studied[p.id]}
                        onToggle={() => setStudiedState(setStudied(p.id, !studied[p.id]))}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
            {PROBLEMS.every((p) => !matches(p)) && <p className="py-10 text-center text-slate-500">No topics match "{q}".</p>}
          </>
        )}

        <footer className="mb-8 mt-10 border-t border-slate-200 pt-4 text-center text-[12px] text-slate-500">
          clearFaang · Prices are approximate Google Cloud list prices, rounded for learning. Scores come from a rule-based rubric and teach
          trade-offs; they do not predict any interview result.
        </footer>
      </main>
    </div>
  );
}
