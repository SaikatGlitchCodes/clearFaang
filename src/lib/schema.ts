// Data-model helpers: what a database or cache node can hold, key vocabulary per store type,
// tips and light linting. Shared by the editor modal, node badges, PNG capture and the AI prompts.

import type { SchemaEntity, SchemaField } from './types';

export type StoreKind = 'sql' | 'doc' | 'wide' | 'cache';

const KIND: Record<string, StoreKind> = {
  'cloud-sql': 'sql',
  alloydb: 'sql',
  spanner: 'sql',
  firestore: 'doc',
  bigtable: 'wide',
  memorystore: 'cache',
  'memorystore-cluster': 'cache',
};

export const isDbService = (serviceId: string): boolean => serviceId in KIND;
export const kindOf = (serviceId: string): StoreKind => KIND[serviceId] ?? 'sql';

export const TYPES: Record<StoreKind, string[]> = {
  sql: ['int', 'bigint', 'varchar', 'text', 'boolean', 'timestamp', 'date', 'decimal', 'json', 'uuid', 'bytes'],
  doc: ['string', 'number', 'boolean', 'timestamp', 'map', 'array', 'reference', 'geopoint', 'bytes'],
  wide: ['string', 'int64', 'bytes', 'timestamp', 'counter'],
  cache: ['string', 'hash', 'list', 'set', 'sorted set', 'counter', 'json'],
};

export const NOUN: Record<StoreKind, { one: string; many: string; placeholder: string }> = {
  sql: { one: 'table', many: 'tables', placeholder: 'users' },
  doc: { one: 'collection', many: 'collections', placeholder: 'users' },
  wide: { one: 'table', many: 'tables', placeholder: 'events' },
  cache: { one: 'key pattern', many: 'key patterns', placeholder: 'user:{id}:profile' },
};

export const KEY_LABEL: Record<StoreKind, Record<'' | 'pk' | 'sk' | 'idx' | 'uq', string>> = {
  sql: { '': 'none', pk: 'Primary key', sk: 'Clustering / sort key', idx: 'Index', uq: 'Unique' },
  doc: { '': 'none', pk: 'Document ID', sk: 'Sort field', idx: 'Indexed field', uq: 'Unique (by design)' },
  wide: { '': 'none', pk: 'Row key', sk: 'Row key part 2', idx: 'Secondary lookup table', uq: 'Unique' },
  cache: { '': 'none', pk: 'Key', sk: 'Hash field / member', idx: 'Secondary key', uq: 'Unique' },
};

const f = (name: string, type: string, key: SchemaField['key'] = ''): SchemaField => ({ name, type, key });

export const PRESETS: Record<StoreKind, { name: string; fields: SchemaField[]; note: string }[]> = {
  sql: [
    { name: 'users', fields: [f('id', 'uuid', 'pk'), f('email', 'varchar', 'uq'), f('name', 'varchar'), f('created_at', 'timestamp', 'idx')], note: 'Look up by id and by email on login. Mostly reads.' },
    { name: 'orders', fields: [f('id', 'uuid', 'pk'), f('user_id', 'uuid', 'idx'), f('status', 'varchar', 'idx'), f('total', 'decimal'), f('created_at', 'timestamp', 'idx')], note: 'List a user\'s orders newest first. Writes on checkout.' },
  ],
  doc: [
    { name: 'users', fields: [f('uid', 'string', 'pk'), f('displayName', 'string'), f('createdAt', 'timestamp', 'idx'), f('settings', 'map')], note: 'Read by uid on app start. Updated rarely.' },
    { name: 'messages', fields: [f('id', 'string', 'pk'), f('roomId', 'string', 'idx'), f('text', 'string'), f('sentAt', 'timestamp', 'sk')], note: 'Query a room\'s latest messages. Append-heavy.' },
  ],
  wide: [
    { name: 'events', fields: [f('device_id', 'string', 'pk'), f('reverse_ts', 'int64', 'sk'), f('payload', 'bytes'), f('type', 'string')], note: 'Row key device_id#reverse_ts: newest events per device first. Heavy writes.' },
    { name: 'counters', fields: [f('entity_id', 'string', 'pk'), f('count', 'counter')], note: 'Point reads and increments by entity id.' },
  ],
  cache: [
    { name: 'user:{id}:profile', fields: [f('key', 'string', 'pk'), f('value', 'json')], note: 'Cache-aside for profile reads. TTL 10 minutes.' },
    { name: 'rate:{ip}:{minute}', fields: [f('key', 'string', 'pk'), f('count', 'counter')], note: 'Fixed-window rate limiter. TTL 60 seconds.' },
  ],
};

export const TIPS: Record<string, string[]> = {
  'cloud-sql': ['Give every table a primary key and index the columns you filter or join on.', 'Keep hot reads on replicas or a cache. One primary takes all writes.', 'Avoid very wide rows and unbounded JSON columns.'],
  alloydb: ['Same relational modelling as PostgreSQL: primary keys plus indexes for your queries.', 'Analytical queries on the same tables are fine here, so keep one schema for both.', 'Use read pool instances for read-heavy access.'],
  spanner: ['Avoid monotonically increasing primary keys (auto-increment, timestamps first): they create hot spots. Use UUIDs or hash-prefixed keys.', 'Interleave child tables with their parent to keep related rows together.', 'Design keys so one transaction touches as few splits as possible.'],
  firestore: ['Design collections around your queries and denormalise instead of joining.', 'Avoid sequential document IDs and sustained writes above about 1 per second to one document.', 'Every query needs an index. Keep documents small (1 MiB limit).'],
  bigtable: ['The row key is the whole design. Choose it for your most common read.', 'Do not lead with a timestamp or sequential ID: it concentrates writes on one node. Use a hashed or entity prefix, and reverse the timestamp for newest-first scans.', 'There are no secondary indexes or joins. Make one table per access pattern if needed.'],
  memorystore: ['Namespace keys (entity:id:aspect) and always set a TTL.', 'Treat it as a cache: the database stays the source of truth.', 'Pick the structure that matches the access (hash for objects, sorted set for leaderboards).'],
  'memorystore-cluster': ['Keys that must be used together need a shared hash tag, for example {user:42}:profile and {user:42}:cart.', 'Always set a TTL, and avoid single huge keys that make one shard hot.', 'Treat it as a cache: the database stays the source of truth.'],
};

export interface Lint {
  level: 'warn' | 'info';
  text: string;
}

export function lintSchema(serviceId: string, entities: SchemaEntity[]): Lint[] {
  const kind = kindOf(serviceId);
  const out: Lint[] = [];
  const names = new Set<string>();
  for (const e of entities) {
    const label = e.name.trim() || `Unnamed ${NOUN[kind].one}`;
    if (!e.name.trim()) out.push({ level: 'warn', text: `Give every ${NOUN[kind].one} a name.` });
    else if (names.has(e.name.trim().toLowerCase())) out.push({ level: 'warn', text: `"${label}" appears twice.` });
    names.add(e.name.trim().toLowerCase());
    if (!e.fields.length) out.push({ level: 'warn', text: `${label} has no fields yet.` });
    const pks = e.fields.filter((x) => x.key === 'pk');
    if (e.fields.length && !pks.length) out.push({ level: 'warn', text: `${label} has no ${KEY_LABEL[kind].pk.toLowerCase()}. Every read needs one.` });
    if (e.fields.some((x) => !x.name.trim())) out.push({ level: 'warn', text: `${label} has an unnamed field.` });
    if (serviceId === 'spanner' && pks.some((p) => ['int', 'bigint', 'timestamp'].includes(p.type)))
      out.push({ level: 'warn', text: `${label}: an integer or timestamp primary key tends to create a Spanner hot spot. Prefer a UUID or hashed key.` });
    if (serviceId === 'bigtable' && pks.some((p) => p.type === 'timestamp')) out.push({ level: 'warn', text: `${label}: a timestamp-only row key sends all writes to one node. Lead with an entity id.` });
    if (kind === 'cache' && !/ttl|expire|seconds|minutes|hour/i.test(e.note ?? '')) out.push({ level: 'info', text: `${label}: say how long it lives (TTL) in the access pattern.` });
    if (!e.note?.trim()) out.push({ level: 'info', text: `${label}: describe how it is read and written, so the key choice can be judged.` });
  }
  return out.slice(0, 8);
}

/** Short lines for the node face and the PNG, e.g. "users: *id, email +2". */
export function schemaLines(entities: SchemaEntity[] | undefined, max = 3): string[] {
  if (!entities?.length) return [];
  const lines = entities.slice(0, max).map((e) => {
    const names = e.fields.slice(0, 3).map((x) => `${x.key === 'pk' ? '*' : ''}${x.name || '?'}`);
    const extra = e.fields.length - names.length;
    return `${e.name || 'unnamed'}: ${names.join(', ')}${extra > 0 ? ` +${extra}` : ''}`;
  });
  if (entities.length > max) lines.push(`+${entities.length - max} more`);
  return lines;
}

export function describeSchema(entities: SchemaEntity[] | undefined): string {
  if (!entities?.length) return '';
  return entities
    .map((e) => `${e.name}(${e.fields.map((x) => `${x.name}:${x.type}${x.key ? ` [${x.key}]` : ''}`).join(', ')})${e.note ? ` - ${e.note}` : ''}`)
    .join('; ');
}

const KEYS = new Set(['', 'pk', 'sk', 'idx', 'uq']);

/** Clean untrusted schema JSON (from the AI or an import). */
export function sanitizeSchema(raw: unknown): SchemaEntity[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SchemaEntity[] = [];
  for (const e of raw.slice(0, 12)) {
    if (typeof e !== 'object' || e === null) continue;
    const r = e as Record<string, unknown>;
    const name = String(r.name ?? '').trim().slice(0, 60);
    if (!name) continue;
    const fields: SchemaField[] = [];
    for (const x of (Array.isArray(r.fields) ? r.fields : []).slice(0, 30)) {
      if (typeof x !== 'object' || x === null) continue;
      const fr = x as Record<string, unknown>;
      const fname = String(fr.name ?? '').trim().slice(0, 40);
      if (!fname) continue;
      const key = String(fr.key ?? '');
      fields.push({ name: fname, type: String(fr.type ?? 'string').slice(0, 20), key: (KEYS.has(key) ? key : '') as SchemaField['key'] });
    }
    out.push({ id: `s${out.length + 1}`, name, fields, ...(typeof r.note === 'string' && r.note.trim() ? { note: r.note.trim().slice(0, 240) } : {}) });
  }
  return out.length ? out : undefined;
}
