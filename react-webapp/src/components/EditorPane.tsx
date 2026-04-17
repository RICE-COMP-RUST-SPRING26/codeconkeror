import CodeEditor from './CodeEditor';
import StatusBar from './StatusBar';
import type { ClientObservableState } from '../types';
import type { ClientDocumentManager } from '../DocumentManager';

interface EditorPaneProps {
  manager: ClientDocumentManager | null;
  state: ClientObservableState | null;
  label?: string;
  readOnly?: boolean;
}

export default function EditorPane({ manager, state, label, readOnly }: EditorPaneProps) {
  const docId = manager?.docId;
  const initialized = state?.initialized ?? false;

  let placeholder = 'Open or create a document to start editing';
  if (docId && !initialized) placeholder = 'Connecting…';
  if (initialized) placeholder = '';

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <StatusBar state={state} label={label} />
      <CodeEditor
        content={state?.displayedContent ?? ''}
        cursor={state?.cursor ?? 0}
        readOnly={readOnly}
        disabled={!initialized}
        placeholder={placeholder}
        externalCursors={state?.externalCursors}
        onEdit={(content, cursor) => manager?.setCurrentState(content, cursor)}
        onCursorMove={(cursor) => manager?.setCursor(cursor)}
      />
    </div>
  );
}
