import type { Problem, Tier } from '../types';
import { BEGINNER } from './beginner';
import { MID } from './mid';
import { SENIOR } from './senior';
import { STAFF } from './staff';

export const PROBLEMS: Problem[] = [...BEGINNER, ...MID, ...SENIOR, ...STAFF];

export function getProblem(id: string): Problem | undefined {
  return PROBLEMS.find((p) => p.id === id);
}

export interface TierMeta {
  id: Tier;
  label: string;
  emoji: string;
  blurb: string;
  checks: string[];
  /** Static Tailwind classes (full strings so Tailwind can see them). */
  badge: string;
  dot: string;
  ring: string;
}

export const TIERS: TierMeta[] = [
  {
    id: 'beginner',
    label: 'Beginner',
    emoji: '🟢',
    blurb: 'Fundamentals: APIs, DB choice, caching and scaling basics.',
    checks: ['DB schema', 'Basic scaling', 'Caching', 'API design'],
    badge: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    dot: 'bg-emerald-500',
    ring: 'hover:border-emerald-300',
  },
  {
    id: 'mid',
    label: 'Mid-level / Strong backend',
    emoji: '🟡',
    blurb: 'Distributed systems thinking.',
    checks: ['Consistency vs availability', 'Event-driven architecture', 'Concurrency control', 'Scaling reads vs writes', 'Caching strategy'],
    badge: 'bg-amber-50 text-amber-700 ring-amber-200',
    dot: 'bg-amber-500',
    ring: 'hover:border-amber-300',
  },
  {
    id: 'senior',
    label: 'Senior / FAANG-level',
    emoji: '🔴',
    blurb: 'Trade-offs, failure handling and multi-region design.',
    checks: ['Sharding strategies', 'Replication', 'Consensus', 'Backpressure handling', 'Disaster recovery', 'Cross-region consistency'],
    badge: 'bg-rose-50 text-rose-700 ring-rose-200',
    dot: 'bg-rose-500',
    ring: 'hover:border-rose-300',
  },
  {
    id: 'staff',
    label: 'Very advanced / Staff+',
    emoji: '🟣',
    blurb: 'Extreme latency, correctness under partition, CAP trade-offs.',
    checks: ['Extreme low latency', 'Correctness under partition', 'Consensus (Raft/Paxos)', 'CAP trade-offs'],
    badge: 'bg-violet-50 text-violet-700 ring-violet-200',
    dot: 'bg-violet-500',
    ring: 'hover:border-violet-300',
  },
];

export const TIER_MAP: Record<Tier, TierMeta> = Object.fromEntries(TIERS.map((t) => [t.id, t])) as Record<Tier, TierMeta>;

/** Problems the learner already marked done in their original list. */
export const SEED_STUDIED: string[] = [
  'notification-system',
  'hotel-booking',
  'ecommerce',
  'food-delivery',
  'ticket-booking',
];
