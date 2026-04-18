import CodeEditor from './CodeEditor';
import StatusBar from './StatusBar';
import type { ClientObservableState } from '../types';
import type { ClientDocumentManager } from '../DocumentManager';
import type { LineDecoration, BlockSpacer } from '../diffUtils';

interface EditorPaneProps {
  manager: ClientDocumentManager | null;
  state: ClientObservableState | null;
  label?: string;
  readOnly?: boolean;
  contentOverride?: string;
  lineDecorations?: LineDecoration[];
  blockSpacers?: BlockSpacer[];
  onScroll?: (scrollTop: number) => void;
  externalScrollTop?: number | null;
}

export default function EditorPane({
  manager,
  state,
  label,
  readOnly,
  contentOverride,
  lineDecorations,
  blockSpacers,
  onScroll,
  externalScrollTop,
}: EditorPaneProps) {
  const docId = manager?.docId;
  const initialized = state?.initialized ?? false;

  let placeholder = 'Open or create a document to start editing';
  if (docId && !initialized) placeholder = 'Connecting…';
  if (initialized) placeholder = '';

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <StatusBar state={state} label={label} />
      <CodeEditor
        content={contentOverride ?? (state?.displayedContent ?? '')}
        cursor={state?.cursor ?? 0}
        readOnly={readOnly}
        disabled={!initialized}
        placeholder={placeholder}
        externalCursors={state?.externalCursors}
        lineDecorations={lineDecorations}
        blockSpacers={blockSpacers}
        onEdit={(content, cursor) => manager?.setCurrentState(content, cursor)}
        onCursorMove={(cursor) => manager?.setCursor(cursor)}
        onScroll={onScroll}
        externalScrollTop={externalScrollTop}
      />
    </div>
  );
}
