// Rule-based evaluation of a design against a problem's rubric.

import type { Design, Problem, ScoreCategory, Tier } from './types';
import { analyze } from './analysis';
import type { Analysis } from './analysis';
import { REQS } from './requirements';
import { rubricFor } from './rubric';
import { autosize } from './autosize';
import { computeCost } from './cost';
import { addNode, connect, emptyDesign } from './design';
import { fmtMoney } from './format';

export const TIER_THRESHOLD: Record<Tier, number> = { beginner: 65, mid: 70, senior: 75, staff: 80 };

export const CATEGORY_LABEL: Record<ScoreCategory, string> = {
  scalability: 'Scalability',
  reliability: 'Reliability',
  performance: 'Performance',
  fit: 'Fit & security',
  cost: 'Cost efficiency',
};

const CATEGORY_WEIGHT: Record<ScoreCategory, number> = {
  scalability: 0.25,
  reliability: 0.22,
  performance: 0.15,
  fit: 0.23,
  cost: 0.15,
};

export interface ReqResult {
  id: string;
  label: string;
  why: string;
  category: ScoreCategory;
  weight: number;
  score: number;
  detail: string;
  note?: string;
  bonus: boolean;
}

export interface Suggestion {
  reqId: string;
  reqLabel: string;
  title: string;
  detail: string;
  impact: number;
  optional: boolean;
  /** Estimated change in monthly cost if applied (USD). */
  costDelta: number;
  apply: (d: Design) => Design;
}

export interface Evaluation {
  overall: number;
  grade: string;
  threshold: number;
  passed: boolean;
  categories: Record<ScoreCategory, number | null>;
  reqs: ReqResult[];
  suggestions: Suggestion[];
  warnings: string[];
  costDetail: string;
  analysis: Analysis;
}

export function gradeFor(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function costScore(total: number, budget: number, quality: number, overProvision: number): { score: number; detail: string } {
  const r = budget > 0 ? total / budget : 1;
  const base = r <= 1 ? 100 : r <= 2 ? 100 - (r - 1) * 50 : Math.max(0, 50 - (r - 2) * 25);
  const waste = overProvision > 5 ? Math.min(20, (overProvision - 5) * 4) : 0;
  // A tiny bill is not "efficient" if the design does not actually work.
  const score = Math.max(0, base - waste) * (0.4 + 0.6 * quality);
  const parts = [`${fmtMoney(total)}/mo vs ~${fmtMoney(budget)} reference budget (${r.toFixed(1)}x)`];
  if (waste > 0) parts.push(`compute is ${overProvision.toFixed(1)}x over-provisioned`);
  if (quality < 0.6) parts.push('score is discounted because the design misses core requirements');
  return { score, detail: parts.join('; ') + '.' };
}

export function evaluate(design: Design, p: Problem, opts: { suggestions?: boolean } = {}): Evaluation {
  const a = analyze(design, p);
  const { g } = a;
  const ctx = { g, a, p };
  const items = rubricFor(p);

  const reqs: ReqResult[] = [];
  const fixesFor: { item: ReqResult; req: string }[] = [];
  for (const item of items) {
    const def = REQS[item.req];
    if (!def) continue;
    const res = def.check(ctx);
    const r: ReqResult = {
      id: def.id,
      label: def.label,
      why: def.why,
      category: def.category,
      weight: item.weight ?? def.weight,
      score: Math.max(0, Math.min(1, res.score)),
      detail: res.detail,
      note: item.note,
      bonus: !!item.bonus,
    };
    reqs.push(r);
    fixesFor.push({ item: r, req: item.req });
  }

  // ---- category scores (core items only)
  const cats: Record<ScoreCategory, number | null> = {
    scalability: null,
    reliability: null,
    performance: null,
    fit: null,
    cost: null,
  };
  (['scalability', 'reliability', 'performance', 'fit'] as ScoreCategory[]).forEach((c) => {
    const core = reqs.filter((r) => r.category === c && !r.bonus);
    const w = core.reduce((s, r) => s + r.weight, 0);
    cats[c] = w > 0 ? (core.reduce((s, r) => s + r.weight * r.score, 0) / w) * 100 : null;
  });

  const present = (['scalability', 'reliability', 'performance', 'fit'] as ScoreCategory[]).filter((c) => cats[c] !== null);
  const quality = present.length ? present.reduce((s, c) => s + (cats[c] as number), 0) / present.length / 100 : 0;
  const cost = costScore(a.cost.total, p.scale.budgetUSD, quality, a.overProvision);
  cats.cost = cost.score;

  // ---- overall
  const catList = (Object.keys(cats) as ScoreCategory[]).filter((c) => cats[c] !== null);
  const wTotal = catList.reduce((s, c) => s + CATEGORY_WEIGHT[c], 0);
  let overall = catList.reduce((s, c) => s + (cats[c] as number) * CATEGORY_WEIGHT[c], 0) / (wTotal || 1);

  const bonus = reqs.filter((r) => r.bonus);
  const bonusMax = bonus.reduce((s, r) => s + r.weight, 0);
  if (bonusMax > 0) overall += Math.min(8, (8 * bonus.reduce((s, r) => s + r.weight * r.score, 0)) / bonusMax);
  overall = Math.max(0, Math.min(100, overall));

  // ---- warnings
  const warnings: string[] = [];
  if (!g.hasClient) warnings.push('Add a Web / Mobile Client node and connect it to your first hop.');
  const orphans = g.orphans();
  if (orphans.length) warnings.push(`Not connected to the client path: ${orphans.map((n) => n.label).join(', ')}.`);
  if (a.overProvision > 8) warnings.push(`Compute is ${a.overProvision.toFixed(0)}x over-provisioned; you are paying for idle capacity.`);
  if (a.cost.total > p.scale.budgetUSD * 2) warnings.push(`Monthly cost is more than 2x the reference budget (${fmtMoney(p.scale.budgetUSD)}).`);

  // ---- suggestions
  const suggestions: Suggestion[] = [];
  if (opts.suggestions !== false) {
    const seen = new Set<string>();
    for (const { item, req } of fixesFor) {
      if (item.score >= 0.85) continue;
      const def = REQS[req];
      const fix = def.fix ? def.fix(ctx) : null;
      if (!fix || seen.has(fix.label)) continue;
      seen.add(fix.label);
      let costDelta = 0;
      try {
        costDelta = computeCost(fix.apply(design), p).total - a.cost.total;
      } catch {
        costDelta = 0;
      }
      suggestions.push({
        reqId: item.id,
        reqLabel: item.label,
        title: fix.label,
        detail: item.detail,
        impact: item.weight * (1 - item.score),
        optional: item.bonus,
        costDelta,
        apply: fix.apply,
      });
    }
    suggestions.sort((x, y) => Number(x.optional) - Number(y.optional) || y.impact - x.impact);
  }

  const threshold = TIER_THRESHOLD[p.tier];
  return {
    overall,
    grade: gradeFor(overall),
    threshold,
    passed: overall >= threshold,
    categories: cats,
    reqs,
    suggestions,
    warnings,
    costDetail: cost.detail,
    analysis: a,
  };
}

/** Build a best-estimate architecture by repeatedly applying the highest-impact suggestions. */
export function buildReference(p: Problem): Design {
  let d: Design = emptyDesign();
  const client = addNode(d, 'client');
  d = client.design;
  const dedicated = p.rubric.some((r) => r.req === 'no-serverless' || r.req === 'min-nodes');
  const compute = dedicated ? addNode(d, 'gce', { config: { instances: 3, machine: '8' } }) : addNode(d, 'cloud-run');
  d = connect(compute.design, client.id, compute.id);

  for (let pass = 0; pass < 3; pass++) {
    const tried = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const ev = evaluate(d, p);
      const next = ev.suggestions.find((s) => !s.optional && !tried.has(s.title));
      if (!next) break;
      tried.add(next.title);
      const nd = next.apply(d);
      if (JSON.stringify(nd) !== JSON.stringify(d)) d = nd;
    }
    d = autosize(d, p).design;
  }
  return d;
}
