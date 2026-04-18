import type { ClientObservableState, BranchSummary } from '../types';

function connBadgeClass(status: string) {
  if (status === 'connected') return 'bg-green-100 text-green-800';
  if (status === 'error') return 'bg-red-100 text-red-800';
  if (status === 'connecting') return 'bg-yellow-100 text-yellow-800';
  return 'bg-gray-100 text-gray-800';
}

interface ShadowControlsProps {
  shadowInput: string;
  shadowBranchNum: number | null;
  shadowState: ClientObservableState | null;
  docId: string | null;
  branches: BranchSummary[];
  currentBranchNum: number;
  onInputChange: (v: string) => void;
  onStart: () => void;
  onStop: () => void;
}

export default function ShadowControls({
  shadowInput,
  shadowBranchNum,
  shadowState,
  docId,
  branches,
  currentBranchNum,
  onInputChange,
  onStart,
  onStop,
}: ShadowControlsProps) {
  const otherBranches = branches.filter((b) => b.branch_num !== currentBranchNum);

  return (
    <div className="flex gap-2 items-center flex-wrap">
      <span className="text-sm text-gray-600 flex-shrink-0">Shadow branch:</span>
      <select
        value={shadowInput}
        onChange={(e) => onInputChange(e.target.value)}
        disabled={shadowBranchNum !== null}
        className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none disabled:bg-gray-100"
      >
        <option value="">— select branch —</option>
        {otherBranches.map((b) => (
          <option key={b.branch_num} value={String(b.branch_num)}>
            #{b.branch_num} · head {b.head_seq}
            {b.parent_branch != null ? ` · from #${b.parent_branch}@${b.parent_seq}` : ''}
          </option>
        ))}
      </select>
      {shadowBranchNum === null ? (
        <button
          onClick={onStart}
          disabled={!docId || !shadowInput}
          className="px-3 py-1 bg-purple-500 hover:bg-purple-600 text-white rounded text-sm disabled:opacity-40"
        >
          Shadow
        </button>
      ) : (
        <>
          <span className="text-sm text-purple-700 font-medium">
            Shadowing branch #{shadowBranchNum}
          </span>
          <span
            className={`px-2 py-0.5 rounded text-xs font-medium ${connBadgeClass(shadowState?.connStatus ?? 'disconnected')}`}
          >
            {shadowState?.connStatus ?? 'disconnected'}
          </span>
          <button
            onClick={onStop}
            className="px-3 py-1 bg-gray-200 hover:bg-gray-300 rounded text-sm"
          >
            Stop
          </button>
        </>
      )}
    </div>
  );
}
