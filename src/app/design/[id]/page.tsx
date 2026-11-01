import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Editor from '@/components/Editor';
import { PROBLEMS, getProblem } from '@/lib/problems';

type Params = Promise<{ id: string }>;

export function generateStaticParams() {
  return PROBLEMS.map((p) => ({ id: p.id }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const p = getProblem(id);
  if (id === 'custom') return { title: 'Custom design · clearFaang' };
  return { title: p ? `${p.title} · clearFaang` : 'clearFaang' };
}

export default async function DesignPage({ params }: { params: Params }) {
  const { id } = await params;
  if (id !== 'custom' && !getProblem(id)) notFound();
  return <Editor problemId={id} />;
}
