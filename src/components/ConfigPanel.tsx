'use client';

import type { Config, ConfigField, ConfigValue } from '@/lib/types';
import { CATEGORY_HEX, SERVICE_MAP, resolveConfig, serviceCapacity } from '@/lib/catalog';
import { fmtGB, fmtMoney, fmtNum } from '@/lib/format';
import { ServiceIcon } from './icons';
import type { ServiceFlowNode } from './flow';

function snap(raw: number, min: number, max: number, step: number): number {
  let v = raw;
  if (raw >= 100) {
    const unit = Math.pow(10, Math.floor(Math.log10(raw)) - 1);
    v = Math.round(raw / unit) * unit;
  }
  v = Math.round(v / step) * step;
  v = Math.min(max, Math.max(min, v));
  return Number(v.toFixed(4));
}

function NumberField({ field, value, onChange }: { field: ConfigField; value: number; onChange: (v: number) => void }) {
  const min = field.min ?? 0;
  const max = field.max ?? 100;
  const step = field.step ?? 1;
  const log = !!field.log && min > 0;
  const span = Math.log(max) - Math.log(min);
  const pos = log ? Math.round((1000 * (Math.log(Math.max(value, min)) - Math.log(min))) / span) : value;
  const lo = log ? 0 : min;
  const hi = log ? 1000 : max;

  const commit = (text: string) => {
    const v = Number(text);
    if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
  };

  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={lo}
        max={hi}
        step={log ? 1 : step}
        value={Math.min(hi, Math.max(lo, pos))}
        onChange={(e) => {
          const raw = Number(e.target.value);
          onChange(log ? snap(Math.exp(Math.log(min) + (raw / 1000) * span), min, max, step) : raw);
        }}
        className="h-1.5 flex-1 cursor-pointer accent-indigo-600"
      />
      <input
        key={value}
        type="number"
        min={min}
        max={max}
        step={step}
        defaultValue={value}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        className="w-24 rounded-md border border-slate-200 px-2 py-1 text-right text-sm outline-none focus:border-indigo-400"
      />
      {field.unit ? <span className="w-12 text-xs text-slate-500">{field.unit}</span> : <span className="w-0" />}
    </div>
  );
}

function FieldRow({ field, value, onChange }: { field: ConfigField; value: ConfigValue; onChange: (v: ConfigValue) => void }) {
  return (
    <div className="mb-4">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label className="text-xs font-medium text-slate-700">{field.label}</label>
      </div>
      {field.type === 'number' && <NumberField field={field} value={Number(value)} onChange={onChange} />}
      {field.type === 'select' && (
        <select
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-indigo-400"
        >
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {field.type === 'toggle' && (
        <button
          type="button"
          role="switch"
          aria-checked={Boolean(value)}
          onClick={() => onChange(!value)}
          className={`relative h-6 w-11 rounded-full transition-colors ${value ? 'bg-indigo-600' : 'bg-slate-300'}`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${value ? 'left-[22px]' : 'left-0.5'}`}
          />
        </button>
      )}
      {field.help ? <p className="mt-1 text-[11px] leading-snug text-slate-500">{field.help}</p> : null}
    </div>
  );
}

export function ConfigPanel({
  node,
  cost,
  onConfig,
  onLabel,
  onDelete,
  onSchema,
}: {
  node: ServiceFlowNode;
  cost: number;
  onConfig: (patch: Config) => void;
  onLabel: (label: string) => void;
  onDelete: () => void;
  /** Present for database and cache nodes: opens the data-model editor. */
  onSchema?: () => void;
}) {
  const def = SERVICE_MAP[node.data.serviceId];
  if (!def) return <p className="p-4 text-sm text-slate-500">Unknown service.</p>;
  const cfg = resolveConfig(def, node.data.config);
  const cap = serviceCapacity(def, cfg);
  const color = CATEGORY_HEX[def.category];

  const capLines: string[] = [];
  if (cap.qps !== undefined) capLines.push(`${fmtNum(cap.qps)} req/s`);
  if (cap.readQps !== undefined) capLines.push(`${fmtNum(cap.readQps)} reads/s`);
  if (cap.writeQps !== undefined) capLines.push(`${fmtNum(cap.writeQps)} writes/s`);
  if (cap.storageGB !== undefined) capLines.push(fmtGB(cap.storageGB));

  return (
    <div className="p-4">
      <div className="mb-3 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white" style={{ backgroundColor: color }}>
          <ServiceIcon name={def.icon} className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900">{def.name}</div>
          <div className="text-xs text-slate-500">{def.category}</div>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold text-slate-900">{fmtMoney(cost)}</div>
          <div className="text-[11px] text-slate-500">per month</div>
        </div>
      </div>

      <p className="mb-2 text-[13px] leading-snug text-slate-700">{def.summary}</p>
      <p className="mb-4 rounded-md bg-slate-50 p-2 text-[12px] leading-snug text-slate-600">
        <span className="font-semibold text-slate-700">Trade-off: </span>
        {def.tradeoff}
      </p>

      <div className="mb-4">
        <label className="mb-1 block text-xs font-medium text-slate-700">Label</label>
        <input
          value={node.data.label ?? ''}
          onChange={(e) => onLabel(e.target.value)}
          placeholder={def.name}
          className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-indigo-400"
        />
      </div>

      {def.fields.length > 0 && (
        <div className="mb-2 border-t border-slate-100 pt-4">
          {def.fields.map((f) => (
            <FieldRow key={f.key} field={f} value={cfg[f.key]} onChange={(v) => onConfig({ [f.key]: v })} />
          ))}
        </div>
      )}

      {capLines.length > 0 && (
        <div className="mb-4 rounded-md border border-slate-200 p-2.5">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Estimated capacity</div>
          <div className="text-sm text-slate-800">{capLines.join(' · ')}</div>
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-1">
        {def.provides.map((c) => (
          <span key={c} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
            {c}
          </span>
        ))}
      </div>

      {onSchema && (
        <button type="button" onClick={onSchema} className="mb-2 w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
          Edit data model{node.data.schema?.length ? ` (${node.data.schema.length})` : ''}
        </button>
      )}

      <button
        type="button"
        onClick={onDelete}
        className="w-full rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
      >
        Remove from design
      </button>
    </div>
  );
}
