'use client';

import { useLayoutEffect, useRef } from 'react';
import { NodeResizer } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';

export type NoteNodeData = {
  text: string;
  editing: boolean;
  w: number;
  h: number;
  onChange: (text: string) => void;
  onEdit: () => void;
  onCommit: () => void;
} & Record<string, unknown>;

export type NoteFlowNode = Node<NoteNodeData, 'note'>;

export const NOTE_DEFAULT = { w: 200, h: 100 };

/** Largest font size (px) at which the text still fits inside the element. */
function fitFont(el: HTMLElement) {
  let lo = 9;
  let hi = 110;
  const fits = (px: number) => {
    el.style.fontSize = `${px}px`;
    return el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1;
  };
  if (fits(hi)) return;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  el.style.fontSize = `${lo}px`;
}

/** Free-form text note on the board. Resize it and the text scales to fit. Not part of the scored design. */
export function NoteNode({ data, selected }: NodeProps<NoteFlowNode>) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = data.editing ? textRef.current : viewRef.current;
    if (el) fitFont(el);
  }, [data.text, data.editing, data.w, data.h]);

  useLayoutEffect(() => {
    if (data.editing && textRef.current) {
      textRef.current.focus();
      textRef.current.setSelectionRange(textRef.current.value.length, textRef.current.value.length);
    }
  }, [data.editing]);

  return (
    <div
      onDoubleClick={data.onEdit}
      className={`sds-note box-border h-full w-full rounded-md border bg-amber-50 p-2 shadow-sm ${
        selected ? 'border-amber-500 ring-2 ring-amber-200' : 'border-amber-200'
      }`}
    >
      <NodeResizer
        isVisible={selected && !data.editing}
        minWidth={90}
        minHeight={44}
        lineClassName="!border-amber-400"
        handleClassName="!h-2.5 !w-2.5 !rounded-sm !border-amber-500 !bg-white"
      />
      {data.editing ? (
        <textarea
          ref={textRef}
          value={data.text}
          placeholder="Type a note…"
          onChange={(e) => data.onChange(e.target.value)}
          onBlur={data.onCommit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
          }}
          className="nodrag nowheel block h-full w-full resize-none overflow-hidden border-0 bg-transparent p-0 leading-tight text-slate-800 outline-none focus:ring-0"
        />
      ) : (
        <div ref={viewRef} className="h-full w-full overflow-hidden whitespace-pre-wrap break-words leading-tight text-slate-800">
          {data.text}
        </div>
      )}
    </div>
  );
}
