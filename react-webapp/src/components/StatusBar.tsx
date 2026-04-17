import type { ClientObservableState } from '../types';

function shortId(id: string) {
  return id.slice(0, 8) + '…' + id.slice(-4);
}

interface StatusBarProps {
  state: ClientObservableState | null;
  label?: string;
}

export default function StatusBar({ state, label }: StatusBarProps) {
  if (!state) return null;
  return (
    <div className="text-xs font-mono text-gray-600 bg-white border border-gray-200 rounded px-2 py-1">
      {label && <span className="font-semibold text-gray-800 mr-2">{label}</span>}
      branch {state.branchNum} · seq {state.lastCommittedState.seqNum} · pending:{' '}
      {state.dispatched ? (
        <span className="text-yellow-600 font-semibold">yes</span>
      ) : (
        'no'
      )}{' '}
      · client {shortId(state.clientId)}
    </div>
  );
}
