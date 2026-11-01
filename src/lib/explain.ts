// Explains a design to the learner: how a request flows through it (read path, write path,
// background work) and why each service is considered good, risky or wasted.
// Uses the same Analysis the scorer uses, so the story always matches the numbers.

import type { Problem } from './types';
import type { Analysis } from './analysis';
import type { GNode } from './graph';
import { serviceCapacity } from './catalog';

export type Tone = 'ok' | 'warn' | 'bad' | 'info';

export interface Hop {
  nodeIds: string[];
  title: string;
  /** Requests per second reaching this hop at peak (undefined when not meaningful). */
  rps?: number;
  note: string;
  tone: Tone;
}

export interface FlowPath {
  id: 'read' | 'write' | 'async';
  title: string;
  summary: string;
  hops: Hop[];
}

export interface ServiceWhy {
  nodeId: string;
  name: string;
  role: string;
  tradeoff: string;
  verdict: Tone;
  reasons: { tone: Tone; text: string }[];
}

export interface Explanation {
  paths: FlowPath[];
  services: ServiceWhy[];
}

const n0 = (n: number) => (n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(n >= 10 ? 0 : 1));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const names = (ns: GNode[]) => ns.map((n) => n.label).join(', ');
const ids = (ns: GNode[]) => ns.map((n) => n.id);

function capTone(cap: number, need: number): Tone {
  if (need <= 0) return 'ok';
  const r = cap / need;
  return r >= 1.3 ? 'ok' : r >= 1 ? 'warn' : 'bad';
}

function capText(what: string, cap: number, need: number): string {
  if (need <= 0) return `${what}: nothing required.`;
  const r = cap / need;
  if (r >= 1.3) return `${what}: ${n0(cap)}/s available for ${n0(need)}/s needed (${r.toFixed(1)}x headroom).`;
  if (r >= 1) return `${what}: ${n0(cap)}/s for ${n0(need)}/s needed. It fits, but a spike would saturate it.`;
  return `${what}: only ${n0(cap)}/s for ${n0(need)}/s needed (${pct(r)}). It will queue up and fail under peak load.`;
}

export function explain(problem: Problem, a: Analysis): Explanation {
  const g = a.g;
  const s = problem.scale;
  const peak = s.peakQps;
  const readRps = a.originPeak * s.readRatio;
  const writeRps = a.originPeak * (1 - s.readRatio);

  const clients = g.nodes.filter((n) => g.is(n, 'client'));
  const dns = g.list('dns');
  const cdn = g.list('cdn');
  const waf = g.list('waf', 'sync');
  const gw = g.list('apigw', 'sync');
  const lb = g.list('lb', 'sync');
  const compute = g.list('compute', 'sync');
  const stores = g.stores();
  const caches = g.list('cache');
  const linkedCaches = caches.filter((c) => g.linkedTo(c, 'compute'));
  const blobs = g.list('blob');
  const queues = g.list(['queue', 'stream']);
  const computeCap = a.computeCap;

  const edge = (): Hop[] => {
    const h: Hop[] = [];
    if (dns.length) h.push({ nodeIds: ids(dns), title: names(dns), note: 'Resolves the service hostname to the nearest entry point.', tone: 'info' });
    if (waf.length) h.push({ nodeIds: ids(waf), title: names(waf), rps: a.originPeak, note: 'Filters abusive and malicious traffic before it can consume compute.', tone: 'info' });
    if (gw.length) h.push({ nodeIds: ids(gw), title: names(gw), rps: a.originPeak, note: 'Authenticates, applies quotas and routes the request to the right backend.', tone: 'info' });
    if (lb.length) h.push({ nodeIds: ids(lb), title: names(lb), rps: a.originPeak, note: 'Spreads requests across compute instances and stops sending to unhealthy ones.', tone: 'info' });
    return h;
  };

  const clientHop = (rps: number, note: string): Hop => ({
    nodeIds: ids(clients),
    title: clients.length ? names(clients) : 'Client',
    rps,
    note,
    tone: clients.length ? 'info' : 'bad',
  });

  const computeHop = (rps: number, what: string): Hop =>
    compute.length
      ? {
          nodeIds: ids(compute),
          title: names(compute),
          rps,
          note: `${what} ${capText('Capacity', computeCap, a.computeNeed)}`,
          tone: capTone(computeCap, a.computeNeed),
        }
      : { nodeIds: [], title: 'No compute', rps, note: 'Nothing runs your application logic, so requests have nowhere to go.', tone: 'bad' };

  // ---------------- read path
  const read: Hop[] = [clientHop(peak * s.readRatio, `Users issue ~${n0(peak)} requests/s at peak, ${pct(s.readRatio)} of them reads.`)];
  read.push(...edge().filter((h) => h.title));
  if (cdn.length) {
    read.splice(1, 0, {
      nodeIds: ids(cdn),
      title: names(cdn),
      rps: peak * s.readRatio,
      note:
        a.cdnOffload > 0
          ? `Answers ~${pct(a.cdnOffload)} of requests from edge caches close to the user, so only ${n0(readRps)}/s of reads travel on to the origin. This is also the cheapest egress.`
          : 'Connected, but this workload is not very cacheable, so little traffic is absorbed.',
      tone: a.cdnOffload > 0 ? 'ok' : 'info',
    });
  } else if (s.cdnFriendly >= 0.4) {
    read.push({ nodeIds: [], title: 'No CDN', rps: readRps, note: `About ${pct(s.cdnFriendly)} of this traffic is cacheable at the edge, but without a CDN every request hits your origin and pays full internet egress.`, tone: 'warn' });
  }
  read.push(computeHop(readRps, 'Runs the request logic and fetches the data.'));
  if (linkedCaches.length) {
    read.push({
      nodeIds: ids(linkedCaches),
      title: names(linkedCaches),
      rps: readRps,
      note: `Checked before the database. Roughly ${pct(a.cacheHitEff)} of reads are answered here in under a millisecond, so ${n0(a.dbReadNeed)}/s misses continue. ${capText('Cache throughput', a.cacheCap, a.cacheNeed)}`,
      tone: capTone(a.cacheCap, a.cacheNeed),
    });
  } else if (caches.length) {
    read.push({ nodeIds: ids(caches), title: names(caches), note: 'In the design but not connected to compute, so it is never read from. It costs money and absorbs nothing.', tone: 'bad' });
  } else if (s.cacheable >= 0.4) {
    read.push({ nodeIds: [], title: 'No cache', rps: readRps, note: `Up to ${pct(s.cacheable)} of reads could be served from memory. Without a cache all ${n0(a.dbReadNeed)}/s hit the database.`, tone: 'warn' });
  }
  if (stores.length) {
    read.push({
      nodeIds: ids(stores),
      title: names(stores),
      rps: a.dbReadNeed,
      note: `Source of truth. ${capText('Read capacity', a.dbReadCap, a.dbReadNeed)}`,
      tone: capTone(a.dbReadCap, a.dbReadNeed),
    });
  } else {
    read.push({ nodeIds: [], title: 'No database', rps: readRps, note: 'Nothing stores the data, so there is nothing durable to read.', tone: s.storageIn === 'blob' ? 'info' : 'bad' });
  }
  if (blobs.length) {
    read.push({ nodeIds: ids(blobs), title: names(blobs), note: 'Holds large objects (files, images, media). Databases keep the metadata, object storage keeps the bytes, which is far cheaper per GB.', tone: 'info' });
  }

  // ---------------- write path
  const write: Hop[] = [clientHop(peak * (1 - s.readRatio), `${pct(1 - s.readRatio)} of requests change data, about ${n0(writeRps)}/s reach the origin.`)];
  if (cdn.length) write.push({ nodeIds: ids(cdn), title: names(cdn), rps: writeRps, note: 'Writes are never cached. The CDN just passes them through.', tone: 'info' });
  write.push(...edge());
  write.push(computeHop(writeRps, 'Validates the write.'));
  const asyncQueues = queues.filter((q) => g.linkedTo(q, 'compute'));
  if (asyncQueues.length) {
    write.push({
      nodeIds: ids(asyncQueues),
      title: names(asyncQueues),
      rps: writeRps,
      note: 'The API enqueues the work and answers immediately. Spikes pile up here instead of crashing the database, and workers drain at a steady pace. This is why the user sees low latency.',
      tone: 'ok',
    });
    const workers = g.list('compute').filter((c) => !g.sync.has(c.id));
    if (workers.length) write.push({ nodeIds: ids(workers), title: names(workers), rps: writeRps, note: 'Background workers consume messages and do the slow or retryable work, off the user path.', tone: 'info' });
  }
  if (stores.length) {
    write.push({
      nodeIds: ids(stores),
      title: names(stores),
      rps: a.dbWriteNeed,
      note: `Persists the change durably. ${capText('Write capacity', a.dbWriteCap, a.dbWriteNeed)}`,
      tone: capTone(a.dbWriteCap, a.dbWriteNeed),
    });
  } else {
    write.push({ nodeIds: [], title: 'No database', rps: writeRps, note: 'Writes have nowhere durable to land. They would be lost on restart.', tone: s.storageIn === 'blob' ? 'info' : 'bad' });
  }
  if (linkedCaches.length) write.push({ nodeIds: ids(linkedCaches), title: names(linkedCaches), note: 'Must be updated or invalidated after a write, otherwise readers see stale data until the entry expires.', tone: 'info' });

  // ---------------- background work
  const asyncNodes = g.nodes.filter((n) => g.isAsync(n) && g.reachable.has(n.id) && !asyncQueues.includes(n));
  const bg: Hop[] = asyncNodes.map((n) => ({
    nodeIds: [n.id],
    title: n.label,
    note: `${n.def.summary} Runs off the request path, so it adds no user-facing latency, but it does add cost.`,
    tone: 'info' as Tone,
  }));

  const paths: FlowPath[] = [
    {
      id: 'read',
      title: 'Read path',
      summary: `How a read travels from the user to the data (${pct(s.readRatio)} of traffic).`,
      hops: read,
    },
    {
      id: 'write',
      title: 'Write path',
      summary: `How a change is accepted and stored (${pct(1 - s.readRatio)} of traffic).`,
      hops: write,
    },
  ];
  if (bg.length) paths.push({ id: 'async', title: 'Background work', summary: 'Services that run beside the request, not in front of it.', hops: bg });

  // ---------------- why each service
  const total = a.cost.total;
  const services: ServiceWhy[] = [];
  for (const n of g.nodes) {
    if (g.is(n, 'client')) continue;
    const reasons: ServiceWhy['reasons'] = [];
    const cost = a.cost.byNode[n.id] ?? 0;
    const cap = serviceCapacity(n.def, n.cfg);

    if (!g.reachable.has(n.id)) {
      reasons.push({ tone: 'bad', text: 'Not connected to the client path. It carries no traffic yet still costs money. Connect it or remove it.' });
    } else {
      if (g.is(n, 'compute')) {
        if (g.sync.has(n.id)) {
          reasons.push({ tone: capTone(computeCap, a.computeNeed), text: `Serves requests directly. ${capText('Combined front-line capacity', computeCap, a.computeNeed)}` });
          if (!g.has('lb') && !g.has('apigw') && compute.length > 1) reasons.push({ tone: 'warn', text: 'Several compute services but no load balancer or gateway decides who gets each request.' });
        } else {
          reasons.push({ tone: 'ok', text: 'Processes work asynchronously from a queue, so slow jobs never block users.' });
        }
      }
      if (g.is(n, ['sql', 'nosql', 'wide-column', 'global-db'])) {
        reasons.push({ tone: capTone(a.dbReadCap, a.dbReadNeed), text: capText('Reads', a.dbReadCap, a.dbReadNeed) });
        reasons.push({ tone: capTone(a.dbWriteCap, a.dbWriteNeed), text: capText('Writes', a.dbWriteCap, a.dbWriteNeed) });
        if (cap.storageGB !== undefined && a.storageNeed > 0)
          reasons.push({ tone: capTone(a.storageCap, a.storageNeed), text: `Storage: ${n0(a.storageCap)} GB of ${n0(a.storageNeed)} GB needed.` });
      }
      if (g.is(n, 'cache')) {
        reasons.push(
          g.linkedTo(n, 'compute')
            ? { tone: 'ok', text: `Connected to compute and absorbing ~${pct(a.cacheHitEff)} of reads, which protects the database.` }
            : { tone: 'bad', text: 'Not connected to compute, so nothing reads from it.' },
        );
      }
      if (g.is(n, 'cdn')) reasons.push({ tone: a.cdnOffload > 0 ? 'ok' : 'warn', text: a.cdnOffload > 0 ? `Offloads ~${pct(a.cdnOffload)} of traffic and cuts egress cost and latency.` : 'Little of this workload is cacheable, so it adds cost without much benefit.' });
      if (g.is(n, ['queue', 'stream'])) {
        const consumers = g.neighbors(n).filter((c) => g.is(c, 'compute'));
        reasons.push(consumers.length ? { tone: 'ok', text: `Decouples producers from consumers (${names(consumers)}) and absorbs bursts.` } : { tone: 'warn', text: 'Nothing consumes from it, so messages would pile up unprocessed.' });
      }
      if (g.is(n, 'lb')) reasons.push({ tone: 'ok', text: 'Gives clients one stable entry point and removes failed instances from rotation.' });
      if (g.is(n, 'waf')) reasons.push({ tone: 'ok', text: 'Blocks common attacks before they reach your application.' });
      if (g.is(n, 'apigw')) reasons.push({ tone: 'ok', text: 'Central place for authentication, quotas and routing.' });
      if (g.is(n, 'blob')) reasons.push({ tone: 'ok', text: 'Cheap, durable storage for large objects. Keeps bulky data out of the database.' });
      if (g.is(n, 'search')) reasons.push({ tone: 'ok', text: 'Purpose-built index for text and ranked queries a normal database handles poorly.' });
    }
    if (total > 0 && cost / total >= 0.3) reasons.push({ tone: 'warn', text: `Accounts for ${pct(cost / total)} of the monthly bill. Check that it is sized for the load, not above it.` });
    if (!reasons.length) reasons.push({ tone: 'info', text: 'Supporting service. It does not sit on the data path, so it is judged on whether the problem needs it.' });

    const verdict: Tone = reasons.some((r) => r.tone === 'bad') ? 'bad' : reasons.some((r) => r.tone === 'warn') ? 'warn' : reasons.some((r) => r.tone === 'ok') ? 'ok' : 'info';
    services.push({ nodeId: n.id, name: n.label, role: n.def.summary, tradeoff: n.def.tradeoff, verdict, reasons });
  }
  const rank: Record<Tone, number> = { bad: 0, warn: 1, ok: 2, info: 3 };
  services.sort((x, y) => rank[x.verdict] - rank[y.verdict]);

  return { paths, services };
}
