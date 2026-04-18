import type { BranchSummary } from "../types";
import refreshIcon from "../assets/refresh.svg?raw";
import forkIcon from "../assets/fork.svg?raw";

interface BranchControlsProps {
    branches: BranchSummary[];
    currentBranchNum: number;
    docId: string | null;
    onBranchChange: (n: number) => void;
    onRefresh: () => void;
    onFork: () => void;
}

export default function BranchControls({
    branches,
    currentBranchNum,
    docId,
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
                            Branch #{b.branch_num}
                            {b.parent_branch != null
                                ? ` · from #${b.parent_branch}@${b.parent_seq}`
                                : ""}
                        </option>
                    ))
                )}
            </select>
            <button
                onClick={onRefresh}
                title="Refresh branches"
                className="p-1.5 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded flex items-center justify-center"
                dangerouslySetInnerHTML={{ __html: refreshIcon }}
            />
            <button
                onClick={onFork}
                disabled={!docId}
                className="flex items-center gap-1.5 px-3 py-1 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded text-sm disabled:opacity-40"
            >
                <span dangerouslySetInnerHTML={{ __html: forkIcon }} className="flex items-center" />
                Fork
            </button>
        </div>
    );
}
