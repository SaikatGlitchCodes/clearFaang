// Dependency-free PNG export of a design: draws the diagram as SVG, rasterises it on a canvas and downloads it.

import type { Edge } from '@xyflow/react';
import { CATEGORY_HEX, SERVICE_MAP, serviceChips } from './catalog';
import { fmtMoney } from './format';
import { schemaLines } from './schema';
import type { ServiceFlowNode } from '../components/flow';

const NODE_W = 200;
const PAD = 48;
const HEADER = 64;

export interface CapNode {
  id: string;
  x: number;
  y: number;
  title: string;
  sub: string;
  chips: string;
  schema?: string[];
  cost?: number;
  color: string;
}
export interface CapNote {
  x: number;
  y: number;
  text: string;
  w?: number;
  h?: number;
}

export function captureNodes(nodes: ServiceFlowNode[], costs: Record<string, number>): CapNode[] {
  const out: CapNode[] = [];
  for (const n of nodes) {
    const def = SERVICE_MAP[n.data.serviceId];
    if (!def) continue;
    out.push({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      title: n.data.label || def.name,
      sub: n.data.label ? def.name : def.category,
      chips: serviceChips(def, n.data.config) || '',
      schema: schemaLines(n.data.schema),
      cost: costs[n.id],
      color: CATEGORY_HEX[def.category],
    });
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const nodeH = (n: CapNode) => (n.chips ? 78 : 58) + (n.schema?.length ? n.schema.length * 14 + 6 : 0);

/** Largest font size at which the text fits the box, mirroring the on-screen auto-fit. */
function fitNote(text: string, w: number, h: number): { lines: string[]; fs: number } {
  for (let fs = 64; fs >= 9; fs--) {
    const cpl = Math.max(1, Math.floor((w - 16) / (fs * 0.56)));
    const lines = wrap(text, cpl, 500);
    const longest = Math.max(...lines.map((l) => l.length));
    if (lines.length * fs * 1.25 <= h - 14 && longest <= cpl + 2) return { lines, fs };
  }
  return { lines: wrap(text, 30, 500), fs: 9 };
}

function wrap(text: string, width: number, maxLines = 12): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > width && line) {
        lines.push(line);
        line = word;
      } else line = (line + ' ' + word).trim();
    }
    lines.push(line);
  }
  return lines.slice(0, maxLines);
}

export function buildSvg(args: { nodes: CapNode[]; edges: Edge[]; notes?: CapNote[]; title: string; subtitle?: string; dark: boolean }): { svg: string; w: number; h: number } {
  const { nodes, edges, dark } = args;
  const notes = args.notes ?? [];
  const c = dark
    ? { bg: '#0a0a0a', node: '#141414', stroke: '#3a3a3a', text: '#fafafa', sub: '#a3a3a3', chip: '#d4d4d4', edge: '#8a8a8a', note: '#2e2208', noteStroke: '#5c4510', noteText: '#fcd34d', badge: '#e5e5e5', badgeText: '#0a0a0a' }
    : { bg: '#ffffff', node: '#ffffff', stroke: '#cbd5e1', text: '#0f172a', sub: '#64748b', chip: '#475569', edge: '#64748b', note: '#fffbeb', noteStroke: '#fde68a', noteText: '#1e293b', badge: '#0f172a', badgeText: '#ffffff' };

  const boxes = [
    ...nodes.map((n) => ({ x: n.x, y: n.y, w: NODE_W, h: nodeH(n) })),
    ...notes.map((n) => ({ x: n.x, y: n.y, w: n.w ?? NODE_W, h: n.h ?? 100 })),
  ];
  const minX = boxes.length ? Math.min(...boxes.map((b) => b.x)) : 0;
  const minY = boxes.length ? Math.min(...boxes.map((b) => b.y)) : 0;
  const maxX = boxes.length ? Math.max(...boxes.map((b) => b.x + b.w)) : 400;
  const maxY = boxes.length ? Math.max(...boxes.map((b) => b.y + b.h)) : 300;
  const w = Math.max(520, maxX - minX + PAD * 2);
  const h = maxY - minY + PAD * 2 + HEADER;
  const ox = PAD - minX;
  const oy = PAD + HEADER - minY;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const parts: string[] = [];
  parts.push(`<rect width="${w}" height="${h}" fill="${c.bg}"/>`);
  parts.push(`<text x="${PAD}" y="${PAD - 6}" font-size="20" font-weight="700" fill="${c.text}">${esc(cut(args.title, 70))}</text>`);
  if (args.subtitle) parts.push(`<text x="${PAD}" y="${PAD + 16}" font-size="13" fill="${c.sub}">${esc(cut(args.subtitle, 120))}</text>`);
  parts.push(`<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${c.edge}"/></marker></defs>`);

  for (const e of edges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    const ah = nodeH(a);
    const bh = nodeH(b);
    const forward = b.x >= a.x + NODE_W - 20;
    const backward = a.x >= b.x + NODE_W - 20;
    let sx: number, sy: number, tx: number, ty: number, d: string;
    if (forward || backward) {
      sx = (forward ? a.x + NODE_W : a.x) + ox;
      tx = (forward ? b.x : b.x + NODE_W) + ox;
      sy = a.y + ah / 2 + oy;
      ty = b.y + bh / 2 + oy;
      const dx = Math.max(40, Math.abs(tx - sx) / 2) * (forward ? 1 : -1);
      d = `M${sx} ${sy} C${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
    } else {
      const down = b.y >= a.y;
      sx = a.x + NODE_W / 2 + ox;
      tx = b.x + NODE_W / 2 + ox;
      sy = (down ? a.y + ah : a.y) + oy;
      ty = (down ? b.y : b.y + bh) + oy;
      const dy = Math.max(30, Math.abs(ty - sy) / 2) * (down ? 1 : -1);
      d = `M${sx} ${sy} C${sx} ${sy + dy}, ${tx} ${ty - dy}, ${tx} ${ty}`;
    }
    parts.push(`<path d="${d}" fill="none" stroke="${c.edge}" stroke-width="1.8" marker-end="url(#ar)"/>`);
  }

  for (const n of nodes) {
    const x = n.x + ox;
    const y = n.y + oy;
    const hh = nodeH(n);
    parts.push(`<rect x="${x}" y="${y}" width="${NODE_W}" height="${hh}" rx="12" fill="${c.node}" stroke="${c.stroke}" stroke-width="1.2"/>`);
    parts.push(`<rect x="${x + 12}" y="${y + 13}" width="32" height="32" rx="8" fill="${n.color}"/>`);
    parts.push(`<text x="${x + 28}" y="${y + 34}" font-size="14" font-weight="700" fill="#fff" text-anchor="middle">${esc(n.title.slice(0, 1).toUpperCase())}</text>`);
    parts.push(`<text x="${x + 54}" y="${y + 26}" font-size="13" font-weight="600" fill="${c.text}">${esc(cut(n.title, 21))}</text>`);
    parts.push(`<text x="${x + 54}" y="${y + 42}" font-size="11" fill="${c.sub}">${esc(cut(n.sub, 26))}</text>`);
    (n.schema ?? []).forEach((l, i) => parts.push(`<text x="${x + 12}" y="${y + (n.chips ? 86 : 66) + i * 14}" font-size="10.5" fill="${c.sub}" font-family="ui-monospace, Menlo, Consolas, monospace">${esc(cut(l, 32))}</text>`));
    if (n.chips) parts.push(`<text x="${x + 12}" y="${y + 66}" font-size="11" fill="${c.chip}">${esc(cut(n.chips, 34))}</text>`);
    if (n.cost && n.cost > 0) {
      const label = `${fmtMoney(n.cost)}/mo`;
      const bw = label.length * 6.2 + 14;
      parts.push(`<rect x="${x + NODE_W - bw + 6}" y="${y - 10}" width="${bw}" height="19" rx="9.5" fill="${c.badge}"/>`);
      parts.push(`<text x="${x + NODE_W - bw / 2 + 6}" y="${y + 3}" font-size="10.5" font-weight="600" fill="${c.badgeText}" text-anchor="middle">${esc(label)}</text>`);
    }
  }

  for (const n of notes) {
    const nw = n.w ?? NODE_W;
    const nh = n.h ?? 100;
    const { lines, fs } = fitNote(n.text, nw, nh);
    const x = n.x + ox;
    const y = n.y + oy;
    parts.push(`<rect x="${x}" y="${y}" width="${nw}" height="${nh}" rx="6" fill="${c.note}" stroke="${c.noteStroke}"/>`);
    lines.forEach((l, i) => parts.push(`<text x="${x + 8}" y="${y + 8 + fs + i * fs * 1.25 - fs * 0.2}" font-size="${fs}" fill="${c.noteText}">${esc(l)}</text>`));
  }

  parts.push(`<text x="${w - PAD}" y="${h - 18}" font-size="12" font-weight="700" fill="${c.sub}" text-anchor="end">clearFaang</text>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">${parts.join('')}</svg>`;
  return { svg, w, h };
}

export async function downloadDesignPng(args: { nodes: CapNode[]; edges: Edge[]; notes?: CapNote[]; title: string; subtitle?: string; dark: boolean; filename: string }): Promise<void> {
  const { svg, w, h } = buildSvg(args);
  const scale = Math.min(2, 8000 / Math.max(w, h));
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Could not render the diagram.'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available.');
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, w, h);
  const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('Could not create the image.');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = args.filename.endsWith('.png') ? args.filename : `${args.filename}.png`;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
