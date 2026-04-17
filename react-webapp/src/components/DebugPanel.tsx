import { buildDebugSegments, summarizePatch } from '../ot';
import type { ClientObservableState } from '../types';

interface DebugPanelProps {
  state: ClientObservableState;
}

export default function DebugPanel({ state }: DebugPanelProps) {
  const segments = buildDebugSegments(
    state.lastCommittedState.content,
    state.rebasedDispatched,
    state.queued,
  );

  return (
    <div className="border border-gray-300 rounded bg-white p-3">
      <p className="text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide">Debug view</p>
      <div className="mb-2 text-xs">
        <span className="inline-block w-3 h-3 bg-white border border-gray-300 rounded-sm mr-1" />
        <span className="text-gray-600 mr-3">committed</span>
        <span className="inline-block w-3 h-3 bg-yellow-200 rounded-sm mr-1" />
        <span className="text-gray-600 mr-3">dispatched (pending)</span>
        <span className="inline-block w-3 h-3 bg-blue-200 rounded-sm mr-1" />
        <span className="text-gray-600">unsent (queued)</span>
      </div>
      <pre className="text-sm font-mono whitespace-pre-wrap break-all leading-relaxed border border-gray-100 rounded p-2 bg-gray-50">
        {segments.map((seg, i) => (
          <span
            key={i}
            className={
              seg.layer === 'pending'
                ? 'bg-yellow-200'
                : seg.layer === 'queued'
                ? 'bg-blue-200'
                : ''
            }
          >
            {seg.text}
          </span>
        ))}
      </pre>
      <div className="mt-2 text-xs text-gray-500 space-y-1">
        <div>
          <span className="font-semibold">lastCommitted ({state.lastCommittedState.seqNum}):</span>{' '}
          <span className="font-mono">{JSON.stringify(state.lastCommittedState.content.slice(0, 80))}</span>
        </div>
        {state.rebasedDispatched && (
          <div>
            <span className="font-semibold">dispatched patch:</span>{' '}
            <span className="font-mono">{summarizePatch(state.rebasedDispatched)}</span>
          </div>
        )}
        <div>
          <span className="font-semibold">queued patch:</span>{' '}
          <span className="font-mono">{summarizePatch(state.queued)}</span>
        </div>
      </div>
    </div>
  );
}
