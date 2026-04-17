import { summarizePatch } from '../ot';
import type { NodeSummary, BranchSummary } from '../types';

interface HistoryPanelProps {
  nodes: NodeSummary[];
  branches: BranchSummary[];
  currentBranchNum: number;
  loading: boolean;
  visible: boolean;
  onToggle: () => void;
  onForkHere: (node: NodeSummary) => void;
  onSwitchBranch: (branchNum: number) => void;
}

export default function HistoryPanel({
  nodes,
  branches,
  currentBranchNum,
  loading,
  visible,
  onToggle,
  onForkHere,
  onSwitchBranch,
}: HistoryPanelProps) {
  const headSeqByBranch = new Map(branches.map((b) => [b.branch_num, b.head_seq]));

  return (
    <div>
      <div className="flex gap-2 items-center">
        <button
          onClick={onToggle}
          disabled={loading}
          className="px-3 py-1 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded text-sm disabled:opacity-40"
        >
          {loading ? 'Loading…' : visible ? 'Hide history' : 'Show history'}
        </button>
        {visible && (
          <span className="text-xs text-gray-500">
            {nodes.length} nodes on branch {currentBranchNum}
          </span>
        )}
      </div>

      {visible && (
        <div className="mt-2 border border-gray-200 rounded bg-white overflow-hidden">
          {nodes.length === 0 ? (
            <p className="text-sm text-gray-500 p-3">(empty)</p>
          ) : (
            <ul className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
              {nodes.map((node) => {
                const isHead = headSeqByBranch.get(currentBranchNum) === node.seq;
                const branchWithThisHead = branches.find(
                  (b) => b.head_seq === node.seq && b.branch_num !== currentBranchNum,
                );
                const author = (node.metadata?.name as string) || (node.metadata?.author as string) || '';
                const ts = node.timestamp
                  ? new Date(node.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19)
                  : '';

                return (
                  <li key={node.seq} className="px-3 py-2 text-xs flex items-start gap-3">
                    <span className="font-mono text-gray-400 w-10 flex-shrink-0 mt-0.5">
                      {String(node.seq).padStart(4, '0')}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-gray-700 truncate">{summarizePatch(node.patch)}</div>
                      <div className="text-gray-400 mt-0.5">
                        {ts}
                        {author ? ` · ${author}` : ''}
                      </div>
                    </div>
                    <div className="flex-shrink-0 flex gap-1">
                      {isHead ? (
                        <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">head</span>
                      ) : branchWithThisHead ? (
                        <button
                          onClick={() => onSwitchBranch(branchWithThisHead.branch_num)}
                          className="px-2 py-0.5 bg-indigo-100 hover:bg-indigo-200 text-indigo-700 rounded text-xs"
                        >
                          Switch to #{branchWithThisHead.branch_num}
                        </button>
                      ) : (
                        <button
                          onClick={() => onForkHere(node)}
                          className="px-2 py-0.5 bg-green-100 hover:bg-green-200 text-green-700 rounded text-xs"
                        >
                          Fork here
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
