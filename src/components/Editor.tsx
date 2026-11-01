'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, MouseEvent as ReactMouseEvent } from 'react';
import Link from 'next/link';
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
import type { Connection, Edge, Node, NodeChange, NodeMouseHandler } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { Config, Design, Problem } from '@/lib/types';
import { isDbService } from '@/lib/schema';
import { CATEGORY_HEX, SERVICE_MAP, defaultConfig } from '@/lib/catalog';
import { analyze } from '@/lib/analysis';
import { autosize } from '@/lib/autosize';
import { addNode, emptyDesign, uid } from '@/lib/design';
import { buildReference, evaluate } from '@/lib/evaluate';
import type { Suggestion } from '@/lib/evaluate';
import type { NodeSim } from '@/lib/simulate';
import { captureNodes, downloadDesignPng } from '@/lib/capture';
import { fmtMoney } from '@/lib/format';
import { TIER_MAP, getProblem } from '@/lib/problems';
import {
  clearDesign,
  loadCustomProblem,
  loadDesign,
  loadNotes,
  loadSubmissions,
  saveDesign,
  saveNotes,
  saveSubmission,
  updateSubmissionNotes,
} from '@/lib/storage';
import type { Note, Submission } from '@/lib/storage';

import { ConfigPanel } from './ConfigPanel';
import { Palette, DRAG_MIME } from './Palette';
import { CompareModal, useCompareDrop } from './compare';
import { useSchemaEditor } from './schema';
import { useServicePlacement } from './placement';
import { BriefPanel, CostPanel, EstimatesPanel } from './panels';
import { Brand } from './Brand';
import { FlowPanel } from './FlowPanel';
import { NOTE_DEFAULT, NoteNode } from './NoteNode';
import { Playground } from './Playground';
import { ResultsModal } from './ResultsModal';
import { ServiceNode } from './ServiceNode';
import { ThemeToggle, useTheme } from './ThemeToggle';
import { EDGE_DEFAULTS, designSignature, fromFlow, toFlowEdges, toFlowNodes } from './flow';
import type { ServiceFlowNode, ServiceNodeData } from './flow';

const nodeTypes = { service: ServiceNode, note: NoteNode };

type Tab = 'brief' | 'node' | 'flow' | 'cost' | 'estimates';

interface ResultsState {
  design: Design;
  savedSig: string;
  latestId: string | null;
}

function starterDesign(): Design {
  return addNode(emptyDesign(), 'client', { x: 40, y: 120 }).design;
}

function EditorInner({ problemId, problem }: { problemId: string; problem: Problem }) {
  const tier = problemId === 'custom' ? { emoji: '✨', label: 'Custom design' } : TIER_MAP[problem.tier];
  const { screenToFlowPosition, fitView } = useReactFlow();
  const theme = useTheme();

  const [nodes, setNodes, onNodesChange] = useNodesState<ServiceFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('brief');
  const [toast, setToast] = useState<string[] | null>(null);
  const [results, setResults] = useState<ResultsState | null>(null);
  const [history, setHistory] = useState<Submission[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // ---- text notes ("T" tool)
  const [notes, setNotes] = useState<Note[]>([]);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [selectedNotes, setSelectedNotes] = useState<string[]>([]);
  const [textTool, setTextTool] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  const commitNote = useCallback((id: string) => {
    setEditingNote((cur) => (cur === id ? null : cur));
    setNotes((ns) => ns.filter((n) => n.id !== id || n.text.trim() !== ''));
  }, []);

  // keyboard: T toggles the text tool, Esc cancels it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        setTextTool((v) => !v);
      } else if (e.key === 'Escape') {
        setTextTool(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const currentDesign = useCallback((): Design => fromFlow(nodesRef.current, edgesRef.current), []);

  /** Replace the whole canvas with a design. */
  const replaceDesign = useCallback(
    (d: Design, fit: boolean) => {
      setNodes(toFlowNodes(d));
      setEdges(toFlowEdges(d));
      setSelectedId(null);
      if (fit) window.setTimeout(() => fitView({ padding: 0.25, maxZoom: 1 }), 80);
    },
    [setNodes, setEdges, fitView],
  );

  // ---- load saved design
  useEffect(() => {
    const initial = loadDesign(problemId) ?? starterDesign();
    // drop nodes that reference services which no longer exist
    const valid: Design = {
      nodes: initial.nodes.filter((n) => SERVICE_MAP[n.serviceId]),
      edges: initial.edges,
    };
    replaceDesign(valid, true);
    setHistory(loadSubmissions(problemId));
    setNotes(loadNotes(problemId));
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemId]);

  // ---- autosave (debounced)
  useEffect(() => {
    if (!loaded) return;
    const t = window.setTimeout(() => saveDesign(problemId, fromFlow(nodes, edges)), 500);
    return () => window.clearTimeout(t);
  }, [nodes, edges, loaded, problemId]);

  useEffect(() => {
    if (!loaded) return;
    const t = window.setTimeout(() => saveNotes(problemId, notes), 500);
    return () => window.clearTimeout(t);
  }, [notes, loaded, problemId]);

  // ---- toast auto-dismiss
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 7000);
    return () => window.clearTimeout(t);
  }, [toast]);

  // ---- live analysis (re-runs on structure/config changes, not on drags)
  const structureKey = useMemo(() => designSignature(fromFlow(nodes, edges)), [nodes, edges]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const analysisDesign = useMemo(() => fromFlow(nodesRef.current, edgesRef.current), [structureKey]);
  const analysis = useMemo(() => analyze(analysisDesign, problem), [analysisDesign, problem]);
  const orphanIds = useMemo(() => new Set(analysis.g.orphans().map((n) => n.id)), [analysis]);

  const [mode, setMode] = useState<'design' | 'play'>('design');
  const [sim, setSim] = useState<Record<string, NodeSim> | null>(null);
  const onSim = useCallback((s: Record<string, NodeSim> | null) => setSim(s), []);

  const getServiceNodes = useCallback(() => nodesRef.current, []);
  const compare = useCompareDrop(getServiceNodes, setNodes);
  const schemaEd = useSchemaEditor(getServiceNodes, setNodes);
  const { open: openSchema } = schemaEd;
  const switchService = (nodeId: string, serviceId: string) => {
    const def = SERVICE_MAP[serviceId];
    if (!def) return;
    setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, serviceId, config: defaultConfig(def) } } : n)));
  };

  const [hl, setHl] = useState<string[]>([]);
  const onHighlight = useCallback((ids: string[]) => setHl((cur) => (cur.length === ids.length && cur.every((x, i) => x === ids[i]) ? cur : ids)), []);
  const hlSet = useMemo(() => new Set(hl), [hl]);

  const displayEdges = useMemo<Edge[]>(() => {
    if (!hl.length) return edges;
    return edges.map((e) => {
      const on = hlSet.has(e.source) && hlSet.has(e.target);
      return { ...e, style: { ...(e.style ?? {}), strokeWidth: on ? 3.2 : 1.6, opacity: on ? 1 : 0.25, stroke: on ? '#f59e0b' : undefined } };
    });
  }, [edges, hl, hlSet]);

  const displayNodes = useMemo<Node[]>(() => {
    const svc: Node[] = nodes.map((n) => ({
      ...n,
      data: {
        ...n.data,
        hl: hl.length ? (hlSet.has(n.id) ? 'on' : 'off') : undefined,
        cmp: compare.target === n.id,
        onSchema: isDbService(n.data.serviceId) ? () => openSchema(n.id) : undefined,
        cost: analysis.cost.byNode[n.id],
        orphan: orphanIds.has(n.id),
        sim: mode === 'play' ? sim?.[n.id] : undefined,
      },
    }));
    const noteNodes: Node[] = notes.map((n) => ({
      id: n.id,
      type: 'note',
      position: { x: n.x, y: n.y },
      selected: selectedNotes.includes(n.id),
      zIndex: 5,
      width: n.w ?? NOTE_DEFAULT.w,
      height: n.h ?? NOTE_DEFAULT.h,
      style: { width: n.w ?? NOTE_DEFAULT.w, height: n.h ?? NOTE_DEFAULT.h },
      data: {
        text: n.text,
        w: n.w ?? NOTE_DEFAULT.w,
        h: n.h ?? NOTE_DEFAULT.h,
        editing: editingNote === n.id,
        onChange: (text: string) => setNotes((ns) => ns.map((x) => (x.id === n.id ? { ...x, text } : x))),
        onEdit: () => setEditingNote(n.id),
        onCommit: () => commitNote(n.id),
      },
    }));
    return [...svc, ...noteNodes];
  }, [nodes, analysis, orphanIds, sim, mode, notes, selectedNotes, editingNote, commitNote, hl, hlSet, compare.target, openSchema]);

  /** Route changes for note nodes to the notes state; everything else goes to React Flow. */
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const noteIds = new Set(notesRef.current.map((n) => n.id));
      const rest: NodeChange[] = [];
      for (const c of changes) {
        if (!('id' in c) || !noteIds.has(c.id)) {
          rest.push(c);
          continue;
        }
        if (c.type === 'position' && c.position) {
          const pos = c.position;
          setNotes((ns) => ns.map((n) => (n.id === c.id ? { ...n, x: Math.round(pos.x), y: Math.round(pos.y) } : n)));
        } else if (c.type === 'dimensions' && c.dimensions && c.resizing !== undefined) {
          const dim = c.dimensions;
          setNotes((ns) => ns.map((n) => (n.id === c.id ? { ...n, w: Math.round(dim.width), h: Math.round(dim.height) } : n)));
        } else if (c.type === 'remove') {
          setNotes((ns) => ns.filter((n) => n.id !== c.id));
        } else if (c.type === 'select') {
          setSelectedNotes((s) => (c.selected ? [...s.filter((x) => x !== c.id), c.id] : s.filter((x) => x !== c.id)));
        }
      }
      if (rest.length) onNodesChange(rest as Parameters<typeof onNodesChange>[0]);
    },
    [onNodesChange],
  );

  // ---- selection housekeeping
  useEffect(() => {
    if (selectedId && !nodes.some((n) => n.id === selectedId)) setSelectedId(null);
  }, [nodes, selectedId]);

  const selected = nodes.find((n) => n.id === selectedId);

  // ---- canvas actions
  const addService = useCallback(
    (serviceId: string, pos?: { x: number; y: number }) => {
      const d = fromFlow(nodesRef.current, edgesRef.current);
      const { design: nd, id } = addNode(d, serviceId, pos ?? {});
      const added = toFlowNodes(nd).find((n) => n.id === id);
      if (!added) return;
      setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), { ...added, selected: true }]);
      setSelectedId(id);
      setTab('node');
    },
    [setNodes],
  );

  const onConnect = useCallback(
    (c: Connection) => setEdges((eds) => addEdge({ ...c, ...EDGE_DEFAULTS }, eds)),
    [setEdges],
  );

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

  const onNodeClick: NodeMouseHandler = useCallback((e, node) => {
    if (tryPlace(e)) return;
    if (node.type === 'note') {
      setSelectedId(null);
      return;
    }
    setSelectedId(node.id);
    setTab('node');
  }, [tryPlace]);

  const onPaneClick = useCallback(
    (e: ReactMouseEvent) => {
      if (tryPlace(e)) return;
      setSelectedId(null);
      if (!textTool) return;
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const id = uid('note');
      setNotes((ns) => [...ns, { id, x: Math.round(pos.x), y: Math.round(pos.y), text: '' }]);
      setEditingNote(id);
      setTextTool(false);
    },
    [textTool, screenToFlowPosition, tryPlace],
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

  const updateLabel = (id: string, label: string) =>
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, label } } : n)));

  const deleteNode = (id: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    setSelectedId(null);
  };

  // ---- toolbar actions
  const runAutosize = () => {
    const res = autosize(currentDesign(), problem);
    if (!res.changes.length) {
      setToast(['Nothing to resize: capacity already covers the graded load (or there is nothing sizeable yet).']);
      return;
    }
    replaceDesign(res.design, false);
    setToast(['Auto-sized to peak load with 30% headroom:', ...res.changes.slice(0, 6)]);
  };

  const reset = () => {
    if (!window.confirm('Clear the canvas and start over? Your attempt history is kept.')) return;
    clearDesign(problemId);
    setNotes([]);
    setEditingNote(null);
    replaceDesign(starterDesign(), true);
  };

  const capture = async () => {
    try {
      await downloadDesignPng({
        nodes: captureNodes(nodesRef.current, analysis.cost.byNode),
        edges: edgesRef.current,
        notes: notesRef.current.filter((n) => n.text.trim()).map((n) => ({ x: n.x, y: n.y, text: n.text, w: n.w ?? NOTE_DEFAULT.w, h: n.h ?? NOTE_DEFAULT.h })),
        title: problem.title,
        subtitle: `${fmtMoney(analysis.cost.total)}/mo estimated · ${analysis.g.nodes.length} services`,
        dark: theme === 'dark',
        filename: `${problemId}-design`,
      });
    } catch (e) {
      setToast([e instanceof Error ? e.message : 'Could not capture the design.']);
    }
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ problemId, design: currentDesign(), notes: notesRef.current }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${problemId}-design.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJson = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as { design?: Design; notes?: Note[] } & Partial<Design>;
        if (Array.isArray(parsed.notes)) {
          setNotes(parsed.notes.filter((n) => n && typeof n.id === 'string' && typeof n.text === 'string' && Number.isFinite(n.x) && Number.isFinite(n.y)));
        }
        const d = parsed.design ?? (parsed as Design);
        if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) throw new Error('bad shape');
        const nodesOk = d.nodes.filter((n) => SERVICE_MAP[n.serviceId]);
        const ids = new Set(nodesOk.map((n) => n.id));
        replaceDesign({ nodes: nodesOk, edges: d.edges.filter((x) => ids.has(x.source) && ids.has(x.target)) }, true);
        setToast(['Design imported.']);
      } catch {
        setToast(['Could not import that file. Expected JSON exported from this app.']);
      }
    };
    reader.readAsText(file);
  };

  // ---- submit / results
  const persistAttempt = (d: Design): Submission => {
    const ev = evaluate(d, problem, { suggestions: false });
    const sub: Submission = {
      id: uid('s'),
      at: Date.now(),
      overall: ev.overall,
      grade: ev.grade,
      passed: ev.passed,
      cost: ev.analysis.cost.total,
      categories: ev.categories,
      notes: '',
      design: d,
    };
    setHistory(saveSubmission(problemId, sub));
    return sub;
  };

  const submit = () => {
    const d = currentDesign();
    const sub = persistAttempt(d);
    setResults({ design: d, savedSig: designSignature(d), latestId: sub.id });
  };

  const applySuggestion = (s: Suggestion) => {
    if (!results) return;
    const nd = s.apply(results.design);
    setResults({ ...results, design: nd });
    replaceDesign(nd, false);
  };

  const saveAttempt = () => {
    if (!results) return;
    const sub = persistAttempt(results.design);
    setResults({ ...results, savedSig: designSignature(results.design), latestId: sub.id });
  };

  const restore = (s: Submission) => {
    replaceDesign(s.design, true);
    setResults(null);
  };

  const showReference = () => {
    if (!results) return;
    if (!window.confirm('Replace the canvas with a suggested architecture? Your current design stays in the attempt history.')) return;
    if (designSignature(results.design) !== results.savedSig) persistAttempt(results.design);
    replaceDesign(buildReference(problem), true);
    setResults(null);
    setToast(['Loaded a suggested architecture. Compare it with yours, tweak the configs, then submit again.']);
  };

  const onNotes = (id: string, notes: string) => setHistory(updateSubmissionNotes(problemId, id, notes));

  // ---- header numbers
  const total = analysis.cost.total;
  const ratio = total / problem.scale.budgetUSD;
  const costTone = ratio <= 1 ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : ratio <= 1.5 ? 'bg-amber-50 text-amber-700 ring-amber-200' : 'bg-red-50 text-red-700 ring-red-200';

  const tabs: { id: Tab; label: string }[] = [
    { id: 'brief', label: 'Brief' },
    { id: 'node', label: 'Service' },
    { id: 'flow', label: 'Flow' },
    { id: 'cost', label: 'Cost' },
    { id: 'estimates', label: 'Estimates' },
  ];

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      {/* top bar */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4">
        <Brand compact />
        <Link href="/" className="rounded-md px-2 py-1 text-sm text-slate-600 hover:bg-slate-100">
          ← Topics
        </Link>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-900">{problem.title}</div>
          <div className="text-[11px] text-slate-500">
            {tier.emoji} {tier.label}
          </div>
        </div>

        <div className={`ml-4 rounded-full px-3 py-1 text-sm font-semibold ring-1 ring-inset ${costTone}`} title="Estimated monthly cost vs the reference budget">
          {fmtMoney(total)}/mo
          <span className="ml-1.5 text-[11px] font-normal opacity-80">of {fmtMoney(problem.scale.budgetUSD)} budget</span>
        </div>

        <div className="ml-4 flex rounded-lg border border-slate-200 p-0.5 text-sm">
          {(['design', 'play'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                if (m === 'design') setSim(null);
              }}
              className={`rounded-md px-3 py-1 font-medium ${mode === m ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
            >
              {m === 'design' ? 'Design' : 'Playground'}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <button type="button" onClick={runAutosize} className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50" title="Resize services to cover peak load with 30% headroom">
            Auto-size
          </button>
          <button type="button" onClick={capture} title="Save the diagram as a PNG image" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
            Capture PNG
          </button>
          <button type="button" onClick={() => fileRef.current?.click()} className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
            Import
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={importJson} />
          <button type="button" onClick={exportJson} className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
            Export
          </button>
          <button type="button" onClick={reset} className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
            Reset
          </button>
          <button type="button" onClick={submit} className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700">
            Submit design
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="shrink-0 overflow-hidden transition-[width] duration-200" style={{ width: leftOpen ? 256 : 0 }}>
          <div className="h-full w-64">
            <Palette
              activeId={placement.placing}
              onAdd={(id, e) => {
                setTextTool(false);
                placement.pick(id, e);
              }}
            />
          </div>
        </div>

        {/* canvas */}
        <main className="relative min-w-0 flex-1">
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
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            onNodesChange={handleNodesChange}
            className={`${textTool ? 'cursor-text' : ''} ${placement.placing ? 'cursor-place' : ''}`}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onNodeDragStart={compare.onNodeDragStart}
            onNodeDrag={compare.onNodeDrag}
            onNodeDragStop={compare.onNodeDragStop}
            onPaneClick={onPaneClick}
            onDrop={onDrop}
            onDragOver={onDragOver}
            nodeTypes={nodeTypes}
            colorMode={theme}
            connectionMode={ConnectionMode.Loose}
            defaultEdgeOptions={EDGE_DEFAULTS}
            deleteKeyCode={['Backspace', 'Delete']}
            minZoom={0.25}
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

          {/* floating tool: Text (T) */}
          <div className="absolute left-3 top-3 z-10">
            <button
              type="button"
              onClick={() => setTextTool((v) => !v)}
              title="Add text note (T)"
              className={`flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold shadow-sm ${
                textTool ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <span className="font-serif text-base leading-none">T</span>
              <span className="text-[12px] font-medium">Text</span>
            </button>
          </div>
          {textTool && (
            <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-slate-900 px-3 py-1 text-[12px] text-white shadow">
              Click anywhere on the board to write a note · Esc to cancel
            </div>
          )}

          {placement.hint}
          {loaded && nodes.length <= 1 && (
            <div className="pointer-events-none absolute inset-x-0 top-24 mx-auto max-w-md rounded-xl border border-dashed border-slate-300 bg-white/80 p-4 text-center text-sm text-slate-600">
              <div className="mb-1 font-semibold text-slate-800">Start designing</div>
              Drag services from the left onto the canvas, then drag from a node's dot to another node to connect them. A typical
              path: Client → Load Balancer → Compute → Cache / Database. Watch the cost and estimates update live.
            </div>
          )}

          {toast && (
            <div className="absolute bottom-4 left-1/2 z-10 w-[min(560px,90%)] -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-3 text-[13px] text-white shadow-xl">
              {toast.map((t, i) => (
                <div key={i} className={i === 0 ? 'font-medium' : 'text-slate-300'}>
                  {t}
                </div>
              ))}
            </div>
          )}
        </main>

        {/* right panel */}
        <div className="shrink-0 overflow-hidden transition-[width] duration-200" style={{ width: rightOpen ? 380 : 0 }}>
        <aside className="flex h-full w-[380px] shrink-0 flex-col border-l border-slate-200 bg-white">
          {mode === 'play' ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <Playground design={analysisDesign} problem={problem} onFrame={onSim} />
            </div>
          ) : (
          <>
          <nav className="flex shrink-0 border-b border-slate-200">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`flex-1 px-2 py-2.5 text-sm font-medium ${
                  tab === t.id ? 'border-b-2 border-indigo-600 text-indigo-700' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'brief' && <BriefPanel problem={problem} />}
            {tab === 'node' &&
              (selected ? (
                <ConfigPanel
                  node={selected}
                  cost={analysis.cost.byNode[selected.id] ?? 0}
                  onConfig={(patch) => updateConfig(selected.id, patch)}
                  onLabel={(l) => updateLabel(selected.id, l)}
                  onDelete={() => deleteNode(selected.id)}
                  onSchema={isDbService(selected.data.serviceId) ? () => openSchema(selected.id) : undefined}
                />
              ) : (
                <p className="p-6 text-sm text-slate-500">Select a service on the canvas to tune its configuration and see how it changes the bill.</p>
              ))}
            {tab === 'flow' && <FlowPanel analysis={analysis} problem={problem} onHighlight={onHighlight} />}
            {tab === 'cost' && <CostPanel analysis={analysis} problem={problem} />}
            {tab === 'estimates' && <EstimatesPanel analysis={analysis} problem={problem} />}
          </div>
          </>
          )}
        </aside>
        </div>
      </div>

      {placement.ghost}

      {schemaEd.modal}
      {compare.pair && <CompareModal pair={compare.pair} problem={problem} onClose={compare.close} onSwitch={switchService} />}

      {results && (
        <ResultsModal
          problem={problem}
          design={results.design}
          history={history}
          latestId={results.latestId}
          hasUnsaved={designSignature(results.design) !== results.savedSig}
          onClose={() => setResults(null)}
          onApply={applySuggestion}
          onSaveAttempt={saveAttempt}
          onRestore={restore}
          onReference={showReference}
          onNotes={onNotes}
        />
      )}
    </div>
  );
}

export default function Editor({ problemId }: { problemId: string }) {
  // 'custom' comes from the AI playground and lives in the browser, so resolve it after mount
  const [problem, setProblem] = useState<Problem | null | undefined>(problemId === 'custom' ? undefined : getProblem(problemId) ?? null);
  useEffect(() => {
    if (problemId === 'custom') setProblem(loadCustomProblem());
  }, [problemId]);
  if (problem === undefined) return null;
  if (problem === null)
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-sm text-slate-600">
        No custom design yet. Generate one in the AI Playground first.
        <Link href="/playground" className="rounded-md bg-indigo-600 px-3 py-1.5 font-semibold text-white">
          Open AI Playground
        </Link>
      </div>
    );
  return (
    <ReactFlowProvider>
      <EditorInner problemId={problemId} problem={problem} />
    </ReactFlowProvider>
  );
}
