'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, MouseEvent as ReactMouseEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import type { Connection, Edge, Node, NodeMouseHandler } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { Config, Design, Problem } from '@/lib/types';
import { isDbService } from '@/lib/schema';
import { CATEGORY_HEX, SERVICE_MAP, defaultConfig } from '@/lib/catalog';
import { autosize } from '@/lib/autosize';
import { addNode, emptyDesign, uid } from '@/lib/design';
import { CATEGORY_LABEL, evaluate } from '@/lib/evaluate';
import type { Evaluation } from '@/lib/evaluate';
import { CONSTRAINT_PROMPTS, DEFAULT_WORKLOAD, EXAMPLE_PROMPTS, customProblem, normalizeWorkload } from '@/lib/aiDesign';
import type { Workload } from '@/lib/aiDesign';
import { captureNodes, downloadDesignPng } from '@/lib/capture';
import { fmtMoney, fmtMs } from '@/lib/format';
import { forgetAiKey, loadAiSettings, saveAiSettings, saveCustomProblem, saveDesign } from '@/lib/storage';
import type { AiSettings } from '@/lib/storage';

import { Brand } from './Brand';
import { ConfigPanel } from './ConfigPanel';
import { DRAG_MIME, Palette } from './Palette';
import { CompareModal, useCompareDrop } from './compare';
import { useSchemaEditor } from './schema';
import { useServicePlacement } from './placement';
import { ServiceNode } from './ServiceNode';
import { ThemeToggle, useTheme } from './ThemeToggle';
import { EDGE_DEFAULTS, designSignature, fromFlow, toFlowEdges, toFlowNodes } from './flow';
import type { ServiceFlowNode, ServiceNodeData } from './flow';

const nodeTypes = { service: ServiceNode };

interface Variant {
  id: string;
  name: string;
  prompt: string;
  design: Design;
  summary: string;
  rationale: string;
  warnings: string[];
  source: 'ai' | 'edit' | 'autosize' | 'manual';
}

const DEFAULTS: AiSettings = { provider: 'anthropic', model: '', remember: false, apiKey: '' };

const blankDesign = (): Design => addNode(emptyDesign(), 'client', { x: 40, y: 120 }).design;

function Meter({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null;
  const tone = value >= 80 ? 'bg-emerald-500' : value >= 60 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="mb-1.5">
      <div className="flex justify-between text-[12px] text-slate-600">
        <span>{label}</span>
        <span className="font-medium text-slate-900">{Math.round(value)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
    </div>
  );
}

function PlaygroundInner() {
  const router = useRouter();
  const theme = useTheme();
  const { screenToFlowPosition, fitView } = useReactFlow();

  const [s, setS] = useState<AiSettings>(DEFAULTS);
  const [hydrated, setHydrated] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [workload, setWorkload] = useState<Workload>(DEFAULT_WORKLOAD);
  const [estimate, setEstimate] = useState(true);
  const [refine, setRefine] = useState(true);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'canvas' | 'json'>('canvas');
  const [leftTab, setLeftTab] = useState<'ai' | 'services'>('ai');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  // ---- the working canvas (same model as the main editor)
  const [nodes, setNodes, onNodesChange] = useNodesState<ServiceFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const canvasDesign = useCallback((): Design => fromFlow(nodesRef.current, edgesRef.current), []);

  const showDesign = useCallback(
    (d: Design) => {
      setNodes(toFlowNodes(d));
      setEdges(toFlowEdges(d));
      setSelectedId(null);
      window.setTimeout(() => fitView({ padding: 0.25, maxZoom: 1 }), 80);
    },
    [setNodes, setEdges, fitView],
  );

  useEffect(() => {
    const saved = loadAiSettings();
    if (saved) setS({ ...DEFAULTS, ...saved });
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (hydrated) saveAiSettings(s);
  }, [s, hydrated]);

  const addVariant = useCallback(
    (v: Omit<Variant, 'id' | 'name'>, label?: string) => {
      const id = uid('v');
      setVariants((vs) => [...vs, { ...v, id, name: label ?? `Design ${vs.length + 1}` }]);
      setActiveId(id);
      setTab('canvas');
      showDesign(v.design);
    },
    [showDesign],
  );

  const addBlank = useCallback(() => {
    addVariant({ prompt: 'Manual design', design: blankDesign(), summary: 'Blank canvas: add and connect services yourself.', rationale: '', warnings: [], source: 'manual' });
  }, [addVariant]);

  // start with a blank canvas so services can be added straight away
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    addBlank();
  }, [addBlank]);

  const activate = (id: string) => {
    const v = variants.find((x) => x.id === id);
    if (!v) return;
    setActiveId(id);
    setTab('canvas');
    showDesign(v.design);
  };

  const active = variants.find((v) => v.id === activeId) ?? null;

  // ---- live analysis of the working canvas
  const structureKey = useMemo(() => designSignature(fromFlow(nodes, edges)), [nodes, edges]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const liveDesign = useMemo(() => fromFlow(nodesRef.current, edgesRef.current), [structureKey]);
  const problem: Problem = useMemo(() => customProblem(workload, active?.prompt ?? prompt), [workload, active, prompt]);
  const liveEval = useMemo<Evaluation | null>(() => {
    try {
      return evaluate(liveDesign, problem, { suggestions: false });
    } catch {
      return null;
    }
  }, [liveDesign, problem]);

  // keep the active variant's snapshot in step with manual edits
  useEffect(() => {
    if (!activeId) return;
    setVariants((vs) => {
      const cur = vs.find((v) => v.id === activeId);
      if (!cur || designSignature(cur.design) === structureKey) return vs;
      return vs.map((v) => (v.id === activeId ? { ...v, design: fromFlow(nodesRef.current, edgesRef.current) } : v));
    });
  }, [structureKey, activeId]);

  const variantKey = variants.map((v) => v.id + designSignature(v.design)).join('|');
  const evals = useMemo(() => {
    const m: Record<string, Evaluation | null> = {};
    for (const v of variants) {
      try {
        m[v.id] = evaluate(v.design, problem, { suggestions: false });
      } catch {
        m[v.id] = null;
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variantKey, problem]);

  const orphans = useMemo(() => new Set(liveEval?.analysis.g.orphans().map((n) => n.id) ?? []), [liveEval]);
  const getServiceNodes = useCallback(() => nodesRef.current, []);
  const compare = useCompareDrop(getServiceNodes, setNodes);
  const schemaEd = useSchemaEditor(getServiceNodes, setNodes);
  const { open: openSchema } = schemaEd;
  const switchService = (nodeId: string, serviceId: string) => {
    const def = SERVICE_MAP[serviceId];
    if (!def) return;
    setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, serviceId, config: defaultConfig(def) } } : n)));
  };

  const displayNodes = useMemo<ServiceFlowNode[]>(
    () => nodes.map((n) => ({ ...n, data: { ...n.data, cost: liveEval?.analysis.cost.byNode[n.id], orphan: orphans.has(n.id), cmp: compare.target === n.id, onSchema: isDbService(n.data.serviceId) ? () => openSchema(n.id) : undefined } })),
    [nodes, liveEval, orphans, compare.target, openSchema],
  );

  // ---- canvas actions
  const addService = useCallback(
    (serviceId: string, pos?: { x: number; y: number }) => {
      const { design: nd, id } = addNode(fromFlow(nodesRef.current, edgesRef.current), serviceId, pos ?? {});
      const added = toFlowNodes(nd).find((n) => n.id === id);
      if (!added) return;
      setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), { ...added, selected: true }]);
      setSelectedId(id);
    },
    [setNodes],
  );

  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge({ ...c, ...EDGE_DEFAULTS }, eds)), [setEdges]);
  const placement = useServicePlacement(
    useCallback(
      (id: string, cx: number, cy: number) => {
        const p = screenToFlowPosition({ x: cx, y: cy });
        addService(id, { x: Math.round(p.x - 100), y: Math.round(p.y - 30) });
      },
      [screenToFlowPosition, addService],
    ),
  );
  const { tryPlace } = placement;
  const onNodeClick: NodeMouseHandler = useCallback(
    (e, node) => {
      if (tryPlace(e)) return;
      setSelectedId(node.id);
    },
    [tryPlace],
  );
  const onPaneClick = useCallback(
    (e: ReactMouseEvent) => {
      if (tryPlace(e)) return;
      setSelectedId(null);
    },
    [tryPlace],
  );
  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);
  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const id = e.dataTransfer.getData(DRAG_MIME);
      if (!id || !SERVICE_MAP[id]) return;
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addService(id, { x: Math.round(pos.x - 100), y: Math.round(pos.y - 30) });
    },
    [screenToFlowPosition, addService],
  );

  const updateConfig = (id: string, patch: Config) =>
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, config: { ...n.data.config, ...patch } } } : n)));
  const updateLabel = (id: string, label: string) => setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, label } } : n)));
  const deleteNode = (id: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    setSelectedId(null);
  };
  const syncPositions = useCallback(() => {
    setVariants((vs) => vs.map((v) => (v.id === activeId ? { ...v, design: fromFlow(nodesRef.current, edgesRef.current) } : v)));
  }, [activeId]);

  const selected = nodes.find((n) => n.id === selectedId);

  // ---- AI generation
  const generate = async () => {
    if (loading) return;
    setError(null);
    if (!prompt.trim()) {
      setError('Describe the system you want to design first.');
      return;
    }
    if (!s.apiKey.trim()) {
      setError('Paste your API key first. It is sent only with your request and never stored on the server.');
      return;
    }
    setLoading(true);
    try {
      const cur = canvasDesign();
      const base = refine && cur.nodes.length > 1 ? cur : undefined;
      const feedback = base && liveEval ? liveEval.reqs.filter((r) => !r.bonus && r.score < 0.7).slice(0, 8).map((r) => `${r.label}: ${r.detail}`) : undefined;
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: s.provider, apiKey: s.apiKey, model: s.model, prompt, workload, estimate, base, feedback }),
      });
      const data = (await res.json()) as { error?: string; design?: Design; summary?: string; rationale?: string; warnings?: string[]; workload?: Workload | null };
      if (!res.ok || !data.design) throw new Error(data.error ?? `Request failed (${res.status})`);
      if (!data.design.nodes.length) throw new Error('The model returned an empty design. Try rephrasing the prompt.');
      if (estimate && data.workload) setWorkload(normalizeWorkload(data.workload));
      addVariant({ prompt: prompt.trim(), design: data.design, summary: data.summary ?? '', rationale: data.rationale ?? '', warnings: data.warnings ?? [], source: 'ai' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed.');
    } finally {
      setLoading(false);
    }
  };

  const runAutosize = () => {
    if (!active) return;
    const res = autosize(canvasDesign(), problem);
    addVariant(
      {
        prompt: 'Auto-size',
        design: res.design,
        summary: res.changes.length ? `Resized ${res.changes.length} setting(s) to cover peak load.` : 'Nothing needed resizing.',
        rationale: res.changes.slice(0, 8).join('\n'),
        warnings: [],
        source: 'autosize',
      },
      `${active.name} (sized)`,
    );
  };

  const duplicate = () => {
    if (!active) return;
    addVariant({ ...active, prompt: active.prompt, design: canvasDesign(), source: 'manual' }, `${active.name} (copy)`);
  };

  const applyJson = () => {
    if (!active) return;
    try {
      const d = JSON.parse(jsonText) as Partial<Design>;
      if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) throw new Error('Expected { "nodes": [...], "edges": [...] }.');
      const ns = d.nodes.filter((n) => SERVICE_MAP[n.serviceId]);
      const ids = new Set(ns.map((n) => n.id));
      setJsonError(null);
      addVariant(
        {
          prompt: 'Edited JSON',
          design: { nodes: ns, edges: d.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) },
          summary: 'Hand-edited design.',
          rationale: '',
          warnings: ns.length < d.nodes.length ? ['Some nodes were dropped: unknown service.'] : [],
          source: 'edit',
        },
        `${active.name} (edited)`,
      );
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : 'Invalid JSON.');
    }
  };

  const capture = async () => {
    try {
      await downloadDesignPng({
        nodes: captureNodes(nodesRef.current, liveEval?.analysis.cost.byNode ?? {}),
        edges: edgesRef.current,
        title: active && active.source !== 'manual' ? active.prompt : active?.name ?? 'Design',
        subtitle: liveEval ? `Score ${Math.round(liveEval.overall)} · ${fmtMoney(liveEval.analysis.cost.total)}/mo estimated` : undefined,
        dark: theme === 'dark',
        filename: `${(active?.name ?? 'design').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not capture the design.');
    }
  };

  const openInEditor = () => {
    saveCustomProblem(customProblem(workload, active?.prompt ?? prompt));
    saveDesign('custom', canvasDesign());
    router.push('/design/custom');
  };

  const removeVariant = (id: string) => {
    const next = variants.filter((v) => v.id !== id);
    if (!next.length) {
      setVariants([]);
      addBlank();
      return;
    }
    setVariants(next);
    if (id === activeId) {
      const last = next[next.length - 1];
      setActiveId(last.id);
      showDesign(last.design);
    }
  };

  const budget = problem.scale.budgetUSD;
  const ev = liveEval;

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4">
        <Brand compact />
        <Link href="/" className="rounded-md px-2 py-1 text-sm text-slate-600 hover:bg-slate-100">
          ← Topics
        </Link>
        <div className="text-sm font-semibold text-slate-900">Playground</div>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={capture} title="Save the diagram as a PNG image" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
            Capture PNG
          </button>
          <ThemeToggle />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* left: AI controls or the service palette */}
        <div className="shrink-0 overflow-hidden transition-[width] duration-200" style={{ width: leftOpen ? 360 : 0 }}>
        <div className="flex h-full w-[360px] flex-col border-r border-slate-200 bg-white">
          <nav className="flex shrink-0 border-b border-slate-200">
            {(
              [
                ['ai', 'Describe with AI'],
                ['services', 'Pick services'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setLeftTab(id)}
                className={`flex-1 px-3 py-2.5 text-sm font-medium ${leftTab === id ? 'border-b-2 border-indigo-600 text-indigo-700' : 'text-slate-500 hover:text-slate-800'}`}
              >
                {label}
              </button>
            ))}
          </nav>

          {leftTab === 'services' ? (
            <Palette onAdd={(id, e) => placement.pick(id, e)} activeId={placement.placing} className="min-h-0 w-full flex-1" />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Model</h3>
              <div className="mb-4 space-y-2 rounded-lg border border-slate-200 p-3">
                <div className="grid grid-cols-2 gap-2">
                  <select value={s.provider} onChange={(e) => setS({ ...s, provider: e.target.value as AiSettings['provider'] })} className="rounded-md border border-slate-200 px-2 py-1.5 text-sm">
                    <option value="anthropic">Anthropic</option>
                    <option value="openai">OpenAI</option>
                  </select>
                  <input
                    value={s.model}
                    onChange={(e) => setS({ ...s, model: e.target.value })}
                    placeholder={s.provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-5-5'}
                    className="rounded-md border border-slate-200 px-2 py-1.5 text-sm"
                  />
                </div>
                <div className="flex gap-2">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={s.apiKey}
                    onChange={(e) => setS({ ...s, apiKey: e.target.value })}
                    placeholder="API key"
                    autoComplete="off"
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-1.5 text-sm"
                  />
                  <button type="button" onClick={() => setShowKey((v) => !v)} className="rounded-md border border-slate-200 px-2 text-[12px] text-slate-600 hover:bg-slate-50">
                    {showKey ? 'Hide' : 'Show'}
                  </button>
                </div>
                <label className="flex items-center gap-2 text-[12px] text-slate-600">
                  <input type="checkbox" checked={s.remember} onChange={(e) => setS({ ...s, remember: e.target.checked })} />
                  Remember the key in this browser
                  {s.apiKey && (
                    <button
                      type="button"
                      onClick={() => {
                        forgetAiKey();
                        setS({ ...s, apiKey: '', remember: false });
                      }}
                      className="ml-auto text-red-600 hover:underline"
                    >
                      Clear
                    </button>
                  )}
                </label>
                <p className="text-[11px] leading-snug text-slate-500">
                  Your key is sent with each request to this app's server, which forwards it to the provider and keeps nothing. Only tick “remember” on a device you
                  trust. Use a key with a spend limit.
                </p>
              </div>

              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">What do you want to design?</h3>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate();
                }}
                rows={5}
                placeholder="Any system, any idea. E.g. 'A food-truck ordering app for a city festival, 20k visitors, must work on bad mobile networks.' Later, use it to ask for changes."
                className="mb-2 w-full resize-y rounded-md border border-slate-200 px-2.5 py-2 text-sm"
              />
              <div className="mb-3 flex flex-wrap gap-1.5">
                {(nodes.length > 1 ? CONSTRAINT_PROMPTS : EXAMPLE_PROMPTS).map((p) => (
                  <button key={p} type="button" onClick={() => setPrompt(p)} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-200">
                    {p}
                  </button>
                ))}
              </div>

              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Workload</h3>
              <div className="mb-4 rounded-lg border border-slate-200 p-3">
                <label className="mb-2 flex items-start gap-2 text-[12px] text-slate-600">
                  <input type="checkbox" className="mt-0.5" checked={estimate} onChange={(e) => setEstimate(e.target.checked)} />
                  <span>Let the AI estimate the workload from my description. Untick to set the numbers yourself and re-score live.</span>
                </label>
                <div className={`grid grid-cols-2 gap-2 ${estimate ? 'opacity-60' : ''}`}>
                  {(
                    [
                      ['peakQps', 'Peak req/s'],
                      ['readRatio', 'Reads %'],
                      ['storageGB', 'Data (GB)'],
                      ['payloadKB', 'Response (KB)'],
                      ['latencyMs', 'p95 target (ms)'],
                      ['budgetUSD', 'Budget ($/mo)'],
                      ['cdnFriendly', 'Edge-cacheable %'],
                      ['cacheable', 'Cacheable reads %'],
                    ] as [keyof Workload, string][]
                  ).map(([k, label]) => {
                    const pct = k === 'readRatio' || k === 'cdnFriendly' || k === 'cacheable';
                    return (
                      <label key={k} className="text-[11px] text-slate-500">
                        {label}
                        <input
                          type="number"
                          min={0}
                          disabled={estimate}
                          value={pct ? Math.round(workload[k] * 100) : workload[k]}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (!Number.isFinite(n)) return;
                            setWorkload((w) => normalizeWorkload({ ...w, [k]: pct ? n / 100 : n }, w));
                          }}
                          className="mt-0.5 w-full rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-900"
                        />
                      </label>
                    );
                  })}
                </div>
              </div>

              <label className="mb-3 flex items-start gap-2 text-[12px] text-slate-600">
                <input type="checkbox" className="mt-0.5" checked={refine} onChange={(e) => setRefine(e.target.checked)} />
                <span>Refine what is on the canvas (including services you added yourself; the model also sees what the scorer flagged) instead of starting fresh.</span>
              </label>
              <button
                type="button"
                onClick={generate}
                disabled={loading}
                className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-60"
              >
                {loading ? 'Designing…' : 'Generate design (Ctrl/⌘ + Enter)'}
              </button>
              {error && <p className="mt-3 rounded-md bg-red-50 p-2.5 text-[12px] leading-snug text-red-700">{error}</p>}
            </div>
          )}
        </div>

        </div>

        {/* canvas */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2">
            {variants.map((v) => {
              const e = v.id === activeId ? liveEval : evals[v.id];
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => activate(v.id)}
                  className={`shrink-0 rounded-lg border px-3 py-1 text-left text-[12px] ${v.id === activeId ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}
                >
                  <div className="font-medium">{v.name}</div>
                  <div className="opacity-70">{e ? `${Math.round(e.overall)} · ${fmtMoney(e.analysis.cost.total)}/mo` : 'n/a'}</div>
                </button>
              );
            })}
            <button type="button" onClick={addBlank} className="shrink-0 rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-[12px] text-slate-600 hover:bg-slate-50">
              + Blank design
            </button>
            <div className="ml-auto flex shrink-0 gap-1 rounded-lg border border-slate-200 p-0.5 text-sm">
              {(['canvas', 'json'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    if (t === 'json') setJsonText(JSON.stringify({ nodes: canvasDesign().nodes, edges: canvasDesign().edges }, null, 2));
                    setTab(t);
                  }}
                  className={`rounded-md px-3 py-0.5 ${tab === t ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                >
                  {t === 'canvas' ? 'Canvas' : 'JSON'}
                </button>
              ))}
            </div>
          </div>

          <div className="relative min-h-0 flex-1">
          <button
            type="button"
            onClick={() => setLeftOpen((v) => !v)}
            title={leftOpen ? 'Hide services panel' : 'Show services panel'}
            className="absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded-r-md border border-l-0 border-slate-200 bg-white px-1.5 py-4 text-sm text-slate-500 shadow-sm hover:text-slate-900"
          >
            {leftOpen ? '‹' : '›'}
          </button>
          <button
            type="button"
            onClick={() => setRightOpen((v) => !v)}
            title={rightOpen ? 'Hide side panel' : 'Show side panel'}
            className="absolute right-0 top-1/2 z-10 -translate-y-1/2 rounded-l-md border border-r-0 border-slate-200 bg-white px-1.5 py-4 text-sm text-slate-500 shadow-sm hover:text-slate-900"
          >
            {rightOpen ? '›' : '‹'}
          </button>
            {placement.hint}
            <div className={`h-full ${tab === 'canvas' ? '' : 'hidden'}`}>
              <ReactFlow
                nodes={displayNodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={onNodeClick}
                onPaneClick={onPaneClick}
                onNodeDragStart={compare.onNodeDragStart}
                onNodeDrag={compare.onNodeDrag}
                onNodeDragStop={(e, n) => {
                  compare.onNodeDragStop(e, n);
                  window.setTimeout(syncPositions, 0);
                }}
                onDrop={onDrop}
                onDragOver={onDragOver}
                className={placement.placing ? 'cursor-place' : undefined}
                nodeTypes={nodeTypes}
                colorMode={theme}
                connectionMode={ConnectionMode.Loose}
                defaultEdgeOptions={EDGE_DEFAULTS}
                deleteKeyCode={['Backspace', 'Delete']}
                minZoom={0.2}
                maxZoom={1.5}
              >
                <Background variant={BackgroundVariant.Dots} gap={18} size={1.4} color={theme === 'dark' ? '#333333' : '#cbd5e1'} />
                <Controls showInteractive={false} />
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={(n: Node) => {
                    const def = SERVICE_MAP[(n.data as ServiceNodeData).serviceId];
                    return def ? CATEGORY_HEX[def.category] : '#94a3b8';
                  }}
                />
              </ReactFlow>
              {nodes.length <= 1 && (
                <div className="pointer-events-none absolute inset-x-0 top-20 mx-auto max-w-md rounded-xl border border-dashed border-slate-300 bg-white/80 p-4 text-center text-sm text-slate-600">
                  <div className="mb-1 font-semibold text-slate-800">Build it your way or ask the AI</div>
                  Open <b>Pick services</b> on the left and drag services here, then drag from a node's dot to connect them. Or use <b>Describe with AI</b> to generate a
                  starting point you can keep editing.
                </div>
              )}
            </div>
            {tab === 'json' && (
              <div className="flex h-full flex-col p-3">
                <textarea
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  spellCheck={false}
                  className="min-h-0 flex-1 resize-none rounded-md border border-slate-200 p-3 font-mono text-[12px]"
                />
                <div className="mt-2 flex items-center gap-3">
                  <button type="button" onClick={applyJson} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700">
                    Apply as new design
                  </button>
                  {jsonError && <span className="text-[12px] text-red-600">{jsonError}</span>}
                </div>
              </div>
            )}
          </div>
        </main>

        {/* right: selected service settings, or results */}
        <div className="shrink-0 overflow-hidden transition-[width] duration-200" style={{ width: rightOpen ? 340 : 0 }}>
        <aside className="h-full w-[340px] overflow-y-auto border-l border-slate-200 bg-white">
          {selected ? (
            <>
              <button type="button" onClick={() => setSelectedId(null)} className="m-3 mb-0 text-[12px] text-slate-500 hover:text-slate-800">
                ← Back to results
              </button>
              <ConfigPanel
                node={selected}
                cost={liveEval?.analysis.cost.byNode[selected.id] ?? 0}
                onConfig={(patch) => updateConfig(selected.id, patch)}
                onLabel={(l) => updateLabel(selected.id, l)}
                onDelete={() => deleteNode(selected.id)}
                onSchema={isDbService(selected.data.serviceId) ? () => openSchema(selected.id) : undefined}
              />
            </>
          ) : !active || !ev ? (
            <p className="p-4 text-sm text-slate-500">Scores, cost and reasoning for the selected design show up here.</p>
          ) : (
            <div className="p-4">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="text-base font-semibold text-slate-900">{active.name}</h2>
                <div className="flex gap-3 text-[12px]">
                  <button type="button" onClick={duplicate} className="text-slate-500 hover:text-slate-800">
                    Duplicate
                  </button>
                  <button type="button" onClick={() => removeVariant(active.id)} className="text-red-600 hover:underline">
                    Remove
                  </button>
                </div>
              </div>
              {active.source !== 'manual' && <p className="mb-3 text-[12px] italic text-slate-500">“{active.prompt}”</p>}

              <div className="mb-3 grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-slate-200 p-2.5">
                  <div className="text-[11px] text-slate-500">Score</div>
                  <div className={`text-2xl font-semibold ${ev.passed ? 'text-emerald-600' : 'text-amber-600'}`}>
                    {Math.round(ev.overall)} <span className="text-sm">{ev.grade}</span>
                  </div>
                  <div className="text-[11px] text-slate-500">pass mark {ev.threshold}</div>
                </div>
                <div className="rounded-lg border border-slate-200 p-2.5">
                  <div className="text-[11px] text-slate-500">Monthly cost</div>
                  <div className={`text-2xl font-semibold ${ev.analysis.cost.total <= budget ? 'text-emerald-600' : 'text-amber-600'}`}>{fmtMoney(ev.analysis.cost.total)}</div>
                  <div className="text-[11px] text-slate-500">budget {fmtMoney(budget)}</div>
                </div>
                <div className="col-span-2 rounded-lg border border-slate-200 p-2.5 text-[12px] text-slate-600">
                  p95 latency <b className="text-slate-900">{ev.analysis.latencyMs > 0 ? fmtMs(ev.analysis.latencyMs) : 'n/a'}</b> · target {fmtMs(problem.scale.latencyMs)}
                </div>
              </div>

              <div className="mb-3">
                {(Object.keys(CATEGORY_LABEL) as (keyof typeof CATEGORY_LABEL)[]).map((k) => (
                  <Meter key={k} label={CATEGORY_LABEL[k]} value={ev.categories[k]} />
                ))}
              </div>

              <div className="mb-4 flex flex-wrap gap-2">
                <button type="button" onClick={openInEditor} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700">
                  Open in editor
                </button>
                <button type="button" onClick={runAutosize} className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
                  Auto-size
                </button>
              </div>

              {active.summary && <p className="mb-2 text-[13px] font-medium text-slate-800">{active.summary}</p>}
              {active.rationale && <p className="mb-4 whitespace-pre-line text-[12px] leading-relaxed text-slate-600">{active.rationale}</p>}

              {ev.reqs.some((r) => !r.bonus && r.score < 0.7) && (
                <>
                  <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Scorer says needs work</h3>
                  <ul className="mb-4 space-y-1.5">
                    {ev.reqs
                      .filter((r) => !r.bonus && r.score < 0.7)
                      .slice(0, 6)
                      .map((r) => (
                        <li key={r.id} className="text-[12px] leading-snug text-slate-600">
                          <span className="font-medium text-slate-800">{r.label}.</span> {r.detail}
                        </li>
                      ))}
                  </ul>
                </>
              )}

              {active.warnings.length > 0 && (
                <>
                  <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Model output fixes</h3>
                  <ul className="mb-4 space-y-1">
                    {active.warnings.slice(0, 8).map((w, i) => (
                      <li key={i} className="text-[11px] leading-snug text-amber-700">
                        {w}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {variants.length > 1 && (
                <>
                  <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Compare</h3>
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="text-left text-slate-500">
                        <th className="pb-1 font-medium">Design</th>
                        <th className="pb-1 text-right font-medium">Score</th>
                        <th className="pb-1 text-right font-medium">Cost/mo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {variants.map((v) => {
                        const e = v.id === activeId ? liveEval : evals[v.id];
                        return (
                          <tr key={v.id} onClick={() => activate(v.id)} className={`cursor-pointer ${v.id === activeId ? 'font-semibold text-slate-900' : 'text-slate-600'}`}>
                            <td className="truncate py-0.5 pr-2">{v.name}</td>
                            <td className="py-0.5 text-right">{e ? Math.round(e.overall) : '-'}</td>
                            <td className="py-0.5 text-right">{e ? fmtMoney(e.analysis.cost.total) : '-'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </aside>
        </div>
      </div>
      {placement.ghost}
      {schemaEd.modal}
      {compare.pair && <CompareModal pair={compare.pair} problem={problem} onClose={compare.close} onSwitch={switchService} />}
    </div>
  );
}

export default function AiPlayground() {
  return (
    <ReactFlowProvider>
      <PlaygroundInner />
    </ReactFlowProvider>
  );
}
