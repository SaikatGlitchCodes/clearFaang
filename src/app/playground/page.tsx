import type { Metadata } from 'next';
import AiPlayground from '@/components/AiPlayground';

export const metadata: Metadata = {
  title: 'AI Playground · clearFaang',
  description: 'Prompt an AI to design systems on Google Cloud, then compare cost and score across variants.',
};

export default function PlaygroundPage() {
  return <AiPlayground />;
}
