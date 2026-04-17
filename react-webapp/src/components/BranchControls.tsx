import type { BranchSummary, ClientObservableState } from '../types';

function connBadgeClass(status: string) {
  if (status === 'connected') return 'bg-green-100 text-green-800';
  if (status === 'error') return 'bg-red-100 text-red-800';
  if (status === 'connecting') return 'bg-yellow-100 text-yellow-800';
  return 'bg-gray-100 text-gray-800';
}

interface BranchControlsProps {
  branches: BranchSummary[];
  currentBranchNum: number;
  docId: string | null;
  state: ClientObservableState | null;
  onBranchChange: (n: number) => void;
  onRefresh: () => void;
  onFork: () => void;
}

export default function BranchControls({
  branches,
  currentBranchNum,
  docId,
  state,
  onBranchChange,
  onRefresh,
  onFork,
}: BranchControlsProps) {
  return (
    <div className="flex gap-2 items-center flex-wrap">
      <select
        value={String(currentBranchNum)}
        onChange={(e) => onBranchChange(Number(e.target.value))}
        className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none"
      >
        {branches.length === 0 ? (
          <option value="0">#0</option>
        ) : (
          branches.map((b) => (
            <option key={b.branch_num} value={String(b.branch_num)}>
              #{b.branch_num} · head {b.head_seq}
              {b.parent_branch != null ? ` · from #${b.parent_branch}@${b.parent_seq}` : ''}
            </option>
          ))
        )}
      </select>
      <button
        onClick={onRefresh}
        className="px-3 py-1 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded text-sm"
      >
        Refresh branches
      </button>
      <button
        onClick={onFork}
        disabled={!docId}
        className="px-3 py-1 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded text-sm disabled:opacity-40"
      >
        Fork from current seq
      </button>
      <div className="ml-auto">
        {state && (
          <span className={`px-2 py-1 rounded text-sm font-medium ${connBadgeClass(state.connStatus)}`}>
            {state.connStatus}
          </span>
        )}
      </div>
    </div>
  );
}
