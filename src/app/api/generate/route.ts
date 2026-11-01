// Proxies one design-generation request to the developer's chosen LLM provider.
// The API key arrives with the request, is used once and is never stored or logged.

import { DEFAULT_WORKLOAD, buildPrompts, normalizeWorkload, parseDesign } from '@/lib/aiDesign';
import type { Design } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 120;

interface Body {
  provider?: 'anthropic' | 'openai';
  apiKey?: string;
  model?: string;
  prompt?: string;
  workload?: unknown;
  estimate?: boolean;
  base?: Design;
  feedback?: string[];
}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

class ProviderError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function callAnthropic(key: string, model: string, system: string, user: string, signal: AbortSignal): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] }),
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string }; content?: { type: string; text?: string }[] };
  if (!res.ok) throw new ProviderError(res.status, data.error?.message ?? `Anthropic returned ${res.status}`);
  return (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
}

async function callOpenAI(key: string, model: string, system: string, user: string, signal: AbortSignal): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string }; choices?: { message?: { content?: string } }[] };
  if (!res.ok) throw new ProviderError(res.status, data.error?.message ?? `OpenAI returned ${res.status}`);
  return data.choices?.[0]?.message?.content ?? '';
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }
  const key = (body.apiKey ?? '').trim();
  const provider = body.provider === 'openai' ? 'openai' : 'anthropic';
  const model = (body.model ?? '').trim() || (provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-5-5');
  const prompt = String(body.prompt ?? '').slice(0, 4000);
  if (!key) return json({ error: 'Add your API key first.' }, 400);
  if (!prompt.trim()) return json({ error: 'Describe the system you want to design.' }, 400);
  if (/[^\w.:\-]/.test(model)) return json({ error: 'That model name looks invalid.' }, 400);

  const { system, user } = buildPrompts({
    prompt,
    workload: normalizeWorkload(body.workload, DEFAULT_WORKLOAD),
    estimate: body.estimate === true,
    base: body.base && Array.isArray(body.base.nodes) ? body.base : undefined,
    feedback: Array.isArray(body.feedback) ? body.feedback.slice(0, 12).map((f) => String(f).slice(0, 300)) : undefined,
  });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 100_000);
  try {
    const text =
      provider === 'openai' ? await callOpenAI(key, model, system, user, ctl.signal) : await callAnthropic(key, model, system, user, ctl.signal);
    return json(parseDesign(text));
  } catch (e) {
    if (e instanceof ProviderError) {
      const hint = e.status === 401 ? 'The provider rejected the API key.' : e.status === 429 ? 'Rate limited or out of quota.' : '';
      return json({ error: `${hint} ${e.message}`.trim() }, e.status >= 400 && e.status < 600 ? e.status : 502);
    }
    if (e instanceof Error && e.name === 'AbortError') return json({ error: 'The model took too long to respond. Try again.' }, 504);
    return json({ error: e instanceof Error ? e.message : 'Generation failed.' }, 502);
  } finally {
    clearTimeout(timer);
  }
}
