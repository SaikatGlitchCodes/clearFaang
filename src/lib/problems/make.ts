import type { DbFit, Problem, RubricItem, Scale, Tier } from '../types';

export interface ProblemInput {
  id: string;
  title: string;
  tier: Tier;
  tagline: string;
  tags: string[];
  functional: string[];
  nonFunctional: string[];
  scale: Partial<Scale> & Pick<Scale, 'audience' | 'avgQps' | 'peakQps' | 'storageGB' | 'budgetUSD'>;
  dbFit?: DbFit;
  rubric: RubricItem[];
  skipBase?: string[];
  pitfalls: string[];
  hints: string[];
}

/** Required rubric item. */
export const R = (req: string, weight?: number, note?: string): RubricItem => ({ req, weight, note });
/** Bonus rubric item (never hurts, adds a few points). */
export const B = (req: string, weight?: number, note?: string): RubricItem => ({ req, weight, note, bonus: true });

export function mk(i: ProblemInput): Problem {
  return {
    ...i,
    scale: {
      readRatio: 0.9,
      storageIn: 'db',
      payloadKB: 5,
      cdnFriendly: 0,
      cacheable: 0.5,
      cacheFirst: false,
      latencyMs: 300,
      availability: '99.9%',
      ...i.scale,
    },
  };
}
