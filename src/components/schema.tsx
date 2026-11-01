'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { SchemaEntity, SchemaField } from '@/lib/types';
import { CATEGORY_HEX, SERVICE_MAP } from '@/lib/catalog';
import { uid } from '@/lib/design';
import { KEY_LABEL, NOUN, PRESETS, TIPS, TYPES, kindOf, lintSchema } from '@/lib/schema';
import { ServiceIcon } from './icons';
import type { ServiceFlowNode } from './flow';

/** Hold a database or cache node (or use its "data model" chip) to describe what it stores. */
export function useSchemaEditor(getNodes: () => ServiceFlowNode[], setNodes: Dispatch<SetStateAction<ServiceFlowNode[]>>) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const open = useCallback((id: string) => setEditingId(id), []);
  const close = useCallback(() => setEditingId(null), []);
  const node = editingId ? getNodes().find((n) => n.id === editingId) : undefined;

  const save = (schema: SchemaEntity[]) => {
    if (!editingId) return;
    setNodes((nds) => nds.map((n) => (n.id === editingId ? { ...n, data: { ...n.data, schema: schema.length ? schema : undefined } } : n)));
    setEditingId(null);
  };

  const modal = node ? <SchemaModal key={node.id} serviceId={node.data.serviceId} title={node.data.label || SERVICE_MAP[node.data.serviceId]?.name || 'Database'} initial={node.data.schema ?? []} onSave={save} onClose={close} /> : null;
  return { open, close, modal };
}

const keyBadge: Record<string, string> = { pk: 'bg-amber-100 text-amber-700', sk: 'bg-sky-50 text-sky-700', idx: 'bg-violet-50 text-violet-700', uq: 'bg-emerald-50 text-emerald-700' };

function SchemaModal({
  serviceId,
  title,
  initial,
  onSave,
  onClose,
}: {
  serviceId: string;
  title: string;
  initial: SchemaEntity[];
  onSave: (s: SchemaEntity[]) => void;
  onClose: () => void;
}) {
  const def = SERVICE_MAP[serviceId];
  const kind = kindOf(serviceId);
  const noun = NOUN[kind];
  const [ents, setEnts] = useState<SchemaEntity[]>(() => JSON.parse(JSON.stringify(initial)) as SchemaEntity[]);
  const [sel, setSel] = useState<string | null>(initial[0]?.id ?? null);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const cur = ents.find((e) => e.id === sel) ?? null;
  const patch = (id: string, p: Partial<SchemaEntity>) => setEnts((es) => es.map((e) => (e.id === id ? { ...e, ...p } : e)));
  const patchField = (id: string, i: number, p: Partial<SchemaField>) =>
    setEnts((es) => es.map((e) => (e.id === id ? { ...e, fields: e.fields.map((x, j) => (j === i ? { ...x, ...p } : x)) } : e)));
  const addEntity = (preset?: (typeof PRESETS)[typeof kind][number]) => {
    const id = uid('t');
    const e: SchemaEntity = preset
      ? { id, name: preset.name, fields: preset.fields.map((x) => ({ ...x })), note: preset.note }
      : { id, name: '', fields: [{ name: kind === 'cache' ? 'key' : 'id', type: TYPES[kind][0], key: 'pk' }] };
    setEnts((es) => [...es, e]);
    setSel(id);
  };
  const removeEntity = (id: string) => {
    setEnts((es) => es.filter((e) => e.id !== id));
    setSel((s) => (s === id ? null : s));
  };

  const lint = lintSchema(serviceId, ents);
  const tips = TIPS[serviceId] ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onMouseDown={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl bg-white shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-3.5">
          {def && (
            <span className="flex h-8 w-8 items-center justify-center rounded-lg text-white" style={{ backgroundColor: CATEGORY_HEX[def.category] }}>
              <ServiceIcon name={def.icon} className="h-4 w-4" />
            </span>
          )}
          <div>
            <h2 className="text-[15px] font-semibold text-slate-900">Data model · {title}</h2>
            <p className="text-[12px] text-slate-500">
              Describe the {noun.many} you will store, their fields and keys, and how they are accessed.
            </p>
          </div>
          <button type="button" onClick={onClose} className="ml-auto rounded-md border border-slate-200 px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50">
            Cancel
          </button>
          <button type="button" onClick={() => onSave(ents.filter((e) => e.name.trim() || e.fields.length))} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700">
            Save
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* entities */}
          <div className="w-52 shrink-0 overflow-y-auto border-r border-slate-200 p-3">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 capitalize">{noun.many}</div>
            {ents.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => setSel(e.id)}
                className={`mb-1 block w-full truncate rounded-md px-2.5 py-1.5 text-left text-[13px] ${sel === e.id ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
              >
                {e.name || `(unnamed ${noun.one})`}
                <span className="ml-1 text-[11px] opacity-60">{e.fields.length}</span>
              </button>
            ))}
            <button type="button" onClick={() => addEntity()} className="mt-1 w-full rounded-md border border-dashed border-slate-300 px-2.5 py-1.5 text-[12px] text-slate-600 hover:bg-slate-50">
              + Add {noun.one}
            </button>
            <div className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Quick start</div>
            {PRESETS[kind].map((p) => (
              <button key={p.name} type="button" onClick={() => addEntity(p)} className="mt-1 block w-full truncate rounded-md bg-slate-100 px-2.5 py-1 text-left text-[12px] text-slate-600 hover:bg-slate-200">
                {p.name}
              </button>
            ))}
          </div>

          {/* editor */}
          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {!cur ? (
              <p className="py-10 text-center text-sm text-slate-500">
                Add a {noun.one} or pick a quick start to begin. Then mark the {KEY_LABEL[kind].pk.toLowerCase()} and any lookups you need.
              </p>
            ) : (
              <>
                <div className="mb-3 flex gap-2">
                  <input value={cur.name} onChange={(e) => patch(cur.id, { name: e.target.value })} placeholder={noun.placeholder} className="min-w-0 flex-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-sm font-semibold" />
                  <button type="button" onClick={() => removeEntity(cur.id)} className="rounded-md border border-slate-200 px-2.5 text-[12px] text-red-600 hover:bg-red-50">
                    Delete
                  </button>
                </div>

                <div className="mb-1 grid grid-cols-[1fr_130px_170px_28px] gap-2 text-[11px] font-medium text-slate-500">
                  <span>Field</span>
                  <span>Type</span>
                  <span>Key</span>
                  <span />
                </div>
                <div className="space-y-1.5">
                  {cur.fields.map((x, i) => (
                    <div key={i} className="grid grid-cols-[1fr_130px_170px_28px] items-center gap-2">
                      <input value={x.name} onChange={(e) => patchField(cur.id, i, { name: e.target.value })} placeholder="field_name" className="min-w-0 rounded-md border border-slate-200 px-2 py-1 text-sm" />
                      <select value={x.type} onChange={(e) => patchField(cur.id, i, { type: e.target.value })} className="rounded-md border border-slate-200 px-1.5 py-1 text-sm">
                        {(TYPES[kind].includes(x.type) ? TYPES[kind] : [x.type, ...TYPES[kind]]).map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                      <select value={x.key ?? ''} onChange={(e) => patchField(cur.id, i, { key: e.target.value as SchemaField['key'] })} className={`rounded-md border border-slate-200 px-1.5 py-1 text-sm ${x.key ? keyBadge[x.key] : ''}`}>
                        {(['', 'pk', 'sk', 'idx', 'uq'] as const).map((k) => (
                          <option key={k} value={k}>
                            {KEY_LABEL[kind][k]}
                          </option>
                        ))}
                      </select>
                      <button type="button" onClick={() => patch(cur.id, { fields: cur.fields.filter((_, j) => j !== i) })} title="Remove field" className="text-slate-400 hover:text-red-600">
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
                <button type="button" onClick={() => patch(cur.id, { fields: [...cur.fields, { name: '', type: TYPES[kind][0], key: '' }] })} className="mt-2 rounded-md border border-dashed border-slate-300 px-2.5 py-1 text-[12px] text-slate-600 hover:bg-slate-50">
                  + Add field
                </button>

                <label className="mt-4 block text-[12px] font-medium text-slate-600">
                  Access pattern
                  <textarea
                    value={cur.note ?? ''}
                    onChange={(e) => patch(cur.id, { note: e.target.value })}
                    rows={2}
                    placeholder={kind === 'cache' ? 'What it caches, who reads it, TTL.' : 'How is it read and written? e.g. get by id (95% reads), list newest 20 per user, ~2k writes/s'}
                    className="mt-1 w-full resize-none rounded-md border border-slate-200 px-2.5 py-1.5 text-sm font-normal"
                  />
                </label>
              </>
            )}

            {lint.length > 0 && (
              <div className="mt-4 rounded-lg bg-slate-50 p-3">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Check</div>
                <ul className="space-y-1">
                  {lint.map((l, i) => (
                    <li key={i} className={`flex gap-2 text-[12px] leading-snug ${l.level === 'warn' ? 'text-amber-700' : 'text-slate-600'}`}>
                      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${l.level === 'warn' ? 'bg-amber-500' : 'bg-slate-400'}`} />
                      {l.text}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {tips.length > 0 && (
              <div className="mt-4">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Modelling tips for {def?.name}</div>
                <ul className="space-y-1">
                  {tips.map((t) => (
                    <li key={t} className="flex gap-2 text-[12px] leading-snug text-slate-600">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
