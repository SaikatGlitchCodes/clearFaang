// Browser persistence (localStorage). Everything here is safe to call on the server: it no-ops.

import type { Design, Problem } from './types';
import { SEED_STUDIED } from './problems';

const PREFIX = 'sds:v1:';

function read<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // quota exceeded or storage disabled: ignore
  }
}

function remove(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}

export interface Submission {
  id: string;
  at: number;
  overall: number;
  grade: string;
  passed: boolean;
  cost: number;
  categories: Record<string, number | null>;
  notes: string;
  design: Design;
}

export function loadDesign(problemId: string): Design | null {
  const d = read<Design | null>(`design:${problemId}`, null);
  return d && Array.isArray(d.nodes) && Array.isArray(d.edges) ? d : null;
}

export function saveDesign(problemId: string, design: Design): void {
  write(`design:${problemId}`, design);
}

export function clearDesign(problemId: string): void {
  remove(`design:${problemId}`);
}

/** Free-form text notes placed on the board (not part of the scored design). */
export interface Note {
  id: string;
  x: number;
  y: number;
  text: string;
  /** Box size in px (defaults to 200 x 100). The text scales to fit. */
  w?: number;
  h?: number;
}

export function loadNotes(problemId: string): Note[] {
  const n = read<Note[]>(`notes:${problemId}`, []);
  return Array.isArray(n) ? n.filter((x) => x && typeof x.id === 'string' && typeof x.text === 'string') : [];
}

export function saveNotes(problemId: string, notes: Note[]): void {
  write(`notes:${problemId}`, notes);
}

/** Learner's own arrangement of the home-page mind map (positions relative to each node's parent). */
export function loadMindMap(): Record<string, { x: number; y: number }> | null {
  const m = read<Record<string, { x: number; y: number }> | null>('mindmap', null);
  return m && typeof m === 'object' ? m : null;
}

export function saveMindMap(m: Record<string, { x: number; y: number }> | null): void {
  if (m === null) remove('mindmap');
  else write('mindmap', m);
}

/** The scenario of the free-form design handed from the AI playground to the editor (/design/custom). */
export function loadCustomProblem(): Problem | null {
  const p = read<Problem | null>('custom-problem', null);
  return p && p.scale && Array.isArray(p.rubric) ? p : null;
}

export function saveCustomProblem(p: Problem): void {
  write('custom-problem', p);
}

/** AI playground settings. The API key is only saved when the user opts in. */
export interface AiSettings {
  provider: 'anthropic' | 'openai';
  model: string;
  remember: boolean;
  apiKey: string;
}

export function loadAiSettings(): AiSettings | null {
  return read<AiSettings | null>('ai', null);
}

export function saveAiSettings(s: AiSettings): void {
  write('ai', s.remember ? s : { ...s, apiKey: '' });
}

export function forgetAiKey(): void {
  const s = loadAiSettings();
  if (s) write('ai', { ...s, apiKey: '', remember: false });
}

export function loadSubmissions(problemId: string): Submission[] {
  const subs = read<Submission[]>(`subs:${problemId}`, []);
  return Array.isArray(subs) ? subs : [];
}

export function saveSubmission(problemId: string, sub: Submission): Submission[] {
  const next = [sub, ...loadSubmissions(problemId)].slice(0, 15);
  write(`subs:${problemId}`, next);
  return next;
}

export function updateSubmissionNotes(problemId: string, id: string, notes: string): Submission[] {
  const next = loadSubmissions(problemId).map((s) => (s.id === id ? { ...s, notes } : s));
  write(`subs:${problemId}`, next);
  return next;
}

/** Best overall score per problem id (only problems with at least one submission). */
export function bestScores(ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) {
    const subs = loadSubmissions(id);
    if (subs.length) out[id] = Math.max(...subs.map((s) => s.overall));
  }
  return out;
}

export function loadStudied(): Record<string, boolean> {
  const stored = read<Record<string, boolean> | null>('studied', null);
  if (stored) return stored;
  const seed: Record<string, boolean> = {};
  for (const id of SEED_STUDIED) seed[id] = true;
  return seed;
}

export function setStudied(id: string, value: boolean): Record<string, boolean> {
  const next = { ...loadStudied(), [id]: value };
  write('studied', next);
  return next;
}
