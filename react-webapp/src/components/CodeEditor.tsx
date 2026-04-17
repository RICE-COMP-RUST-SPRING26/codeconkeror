import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { EditorState, StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import type { ExternalCursor } from '../types';

function clientColor(clientId: string): string {
  let hash = 0;
  for (let i = 0; i < clientId.length; i++) {
    hash = (hash * 31 + clientId.charCodeAt(i)) & 0x7fffffff;
  }
  const hue = (hash % 360 + 360) % 360;
  return `hsl(${hue}, 65%, 50%)`;
}

type CursorInfo = { pos: number; name: string; color: string };

class ExternalCursorWidget extends WidgetType {
  constructor(readonly name: string, readonly color: string) { super(); }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.style.cssText = 'position: relative; display: inline-block; width: 0; overflow: visible; pointer-events: none;';

    const bar = document.createElement('span');
    bar.style.cssText = `position: absolute; top: 0; bottom: -2px; left: 0; width: 2px; background: ${this.color};`;

    const label = document.createElement('span');
    label.textContent = this.name || '?';
    label.style.cssText = [
      'position: absolute',
      'bottom: 100%',
      'left: 0',
      `background: ${this.color}`,
      'color: white',
      'font-size: 10px',
      'line-height: 1.4',
      'padding: 1px 4px',
      'border-radius: 3px 3px 3px 0',
      'white-space: nowrap',
      'font-family: sans-serif',
      'margin-bottom: 1px',
    ].join('; ');

    wrapper.appendChild(label);
    wrapper.appendChild(bar);
    return wrapper;
  }

  eq(other: ExternalCursorWidget) {
    return other.name === this.name && other.color === this.color;
  }
}

const setCursorsEffect = StateEffect.define<CursorInfo[]>();

const externalCursorsField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(decos, tr) {
    decos = decos.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setCursorsEffect)) {
        const sorted = [...effect.value].sort((a, b) => a.pos - b.pos);
        const builder = new RangeSetBuilder<Decoration>();
        for (const c of sorted) {
          const pos = Math.max(0, Math.min(c.pos, tr.newDoc.length));
          builder.add(pos, pos, Decoration.widget({
            widget: new ExternalCursorWidget(c.name, c.color),
            side: 1,
          }));
        }
        decos = builder.finish();
      }
    }
    return decos;
  },
  provide: f => EditorView.decorations.from(f),
});

interface CodeEditorProps {
  content: string;
  cursor: number;
  readOnly?: boolean;
  disabled?: boolean;
  placeholder?: string;
  externalCursors?: Map<string, ExternalCursor>;
  onEdit?: (content: string, cursor: number) => void;
  onCursorMove?: (cursor: number) => void;
}

export default function CodeEditor({
  content,
  cursor,
  readOnly = false,
  disabled = false,
  placeholder,
  externalCursors,
  onEdit,
  onCursorMove,
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const isExternalRef = useRef(false);
  const onEditRef = useRef(onEdit);
  const onCursorMoveRef = useRef(onCursorMove);

  useEffect(() => { onEditRef.current = onEdit; }, [onEdit]);
  useEffect(() => { onCursorMoveRef.current = onCursorMove; }, [onCursorMove]);

  // Create editor once
  useEffect(() => {
    if (!containerRef.current) return;

    const extensions = [
      basicSetup,
      externalCursorsField,
      EditorView.updateListener.of((update) => {
        if (isExternalRef.current) return;
        if (update.docChanged) {
          const newContent = update.state.doc.toString();
          const cur = update.state.selection.main.head;
          onEditRef.current?.(newContent, cur);
        } else if (update.selectionSet) {
          onCursorMoveRef.current?.(update.state.selection.main.head);
        }
      }),
      EditorView.theme({
        '&': { height: '100%', fontSize: '13px' },
        '.cm-content': { fontFamily: 'monospace', minHeight: '200px' },
        '.cm-scroller': { overflow: 'auto' },
      }),
    ];

    if (readOnly || disabled) {
      extensions.push(EditorState.readOnly.of(true));
    }

    const view = new EditorView({
      state: EditorState.create({ doc: '', extensions }),
      parent: containerRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [readOnly, disabled]);

  // Sync content/cursor from outside
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentContent = view.state.doc.toString();
    const currentCursor = view.state.selection.main.head;
    const clampedCursor = Math.min(cursor, content.length);

    if (currentContent === content && currentCursor === clampedCursor) return;

    isExternalRef.current = true;
    try {
      if (currentContent !== content) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: content },
          selection: { anchor: clampedCursor },
        });
      } else {
        view.dispatch({ selection: { anchor: clampedCursor } });
      }
    } finally {
      isExternalRef.current = false;
    }
  }, [content, cursor]);

  // Sync external cursor decorations
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const cursors: CursorInfo[] = [];
    if (externalCursors) {
      for (const [id, ec] of externalCursors) {
        const name = (ec.metadata?.name as string) || id.slice(0, 6);
        cursors.push({ pos: ec.pos, name, color: clientColor(id) });
      }
    }
    view.dispatch({ effects: setCursorsEffect.of(cursors) });
  }, [externalCursors]);

  return (
    <div
      ref={containerRef}
      className={`border rounded overflow-hidden h-64 ${
        disabled ? 'opacity-50 pointer-events-none' : ''
      }`}
      data-placeholder={placeholder}
    />
  );
}
