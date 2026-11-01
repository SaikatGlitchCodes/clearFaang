import type { Problem, RubricItem } from './types';

/** Items every problem is graded on unless it lists them itself or opts out via `skipBase`. */
export const BASE_RUBRIC: RubricItem[] = [
  { req: 'entry' },
  { req: 'compute-capacity' },
  { req: 'lb' },
  { req: 'ha-compute' },
  { req: 'observability' },
];

export function rubricFor(p: Problem): RubricItem[] {
  const listed = new Set(p.rubric.map((r) => r.req));
  const skip = new Set(p.skipBase ?? []);
  const base = BASE_RUBRIC.filter((b) => !listed.has(b.req) && !skip.has(b.req));
  return [...p.rubric, ...base];
}
