import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { HistoryTree } from "./HistoryTree";
import HistoryTreeNode from "./HistoryTreeNode";
import type { VersionNode } from "./HistoryTree";
import type { ClientDocumentManager } from "../../DocumentManager";
import type { NodeSummary, BranchSummary } from "../../types";

const CHUNK_SIZE = 50;

interface BranchLoadState {
    nodes: VersionNode<NodeSummary>[];
    lowestSeqLoaded: number;
}

interface HistoryTreeDriverProps {
    manager: ClientDocumentManager | null;
    currentBranchNum: number;
    currentSeqNum: number;
    branches: BranchSummary[];
    onForkHere: (node: NodeSummary) => void;
    onCompareBranch?: (branchNum: number) => void;
    onOpenBranch?: (branchNum: number) => void;
}

// Helper to transform raw API nodes into the VersionNode format React Flow needs
const formatNodes = (nodes: NodeSummary[], branchNum: number): VersionNode<NodeSummary>[] => {
    return nodes.map((n) => ({
        seq: n.seq,
        value: { ...n, branch_num: branchNum },
        timestamp: new Date(n.timestamp * 1000),
        username: (n.metadata?.name as string) ?? (n.metadata?.author as string) ?? "",
    }));
};

export default function HistoryTreeDriver({
    manager,
    currentBranchNum,
    currentSeqNum,
    branches,
    onForkHere,
    onCompareBranch,
    onOpenBranch,
}: HistoryTreeDriverProps) {
    const branchDataRef = useRef<Map<number, BranchLoadState>>(new Map());
    const [branchData, setBranchDataRaw] = useState<Map<number, BranchLoadState>>(new Map());

    const setBranchData = useCallback(
        (updater: (prev: Map<number, BranchLoadState>) => Map<number, BranchLoadState>) => {
            const next = updater(branchDataRef.current);
            branchDataRef.current = next;
            setBranchDataRaw(next);
        },
        [],
    );

    const loadBranch = useCallback(
        async (branchNum: number, headSeq: number, parentSeq: number | null) => {
            if (!manager || headSeq < 1) return;
            const minSeq = parentSeq !== null ? parentSeq + 1 : 1;
            const start = Math.max(minSeq, headSeq - CHUNK_SIZE + 1);

            try {
                const data = await manager.fetchNodes(start, headSeq, branchNum);
                const formattedNodes = formatNodes(data.nodes, branchNum);

                setBranchData((prev) => {
                    const next = new Map(prev);
                    next.set(branchNum, { nodes: formattedNodes, lowestSeqLoaded: start });
                    return next;
                });
            } catch (e) {
                console.error("HistoryTreeDriver fetchNodes:", e);
            }
        },
        [manager, setBranchData],
    );

    // Load older history for a branch when HistoryTree requests it
    const loadMoreHistory = useCallback(
        async (branchNum: number) => {
            if (!manager) return;
            const current = branchDataRef.current.get(branchNum);
            if (!current) return;

            const branchSummary = branches.find((b) => b.branch_num === branchNum);
            const minSeq = branchSummary?.parent_seq != null ? branchSummary.parent_seq + 1 : 1;

            if (current.lowestSeqLoaded <= minSeq) return;
            const end = current.lowestSeqLoaded - 1;
            const start = Math.max(minSeq, end - CHUNK_SIZE + 1);

            try {
                const data = await manager.fetchNodes(start, end, branchNum);
                const formattedNewNodes = formatNodes(data.nodes, branchNum);

                setBranchData((prev) => {
                    const next = new Map(prev);
                    const existing = next.get(branchNum);
                    if (!existing) return prev;

                    next.set(branchNum, {
                        nodes: [...formattedNewNodes, ...existing.nodes],
                        lowestSeqLoaded: start,
                    });
                    return next;
                });
            } catch (e) {
                console.error("HistoryTreeDriver fetchNodes (more):", e);
            }
        },
        [manager, setBranchData, branches],
    );

    useEffect(() => {
        for (const branch of branches) {
            if (!branchDataRef.current.has(branch.branch_num)) {
                void loadBranch(branch.branch_num, branch.head_seq, branch.parent_seq ?? null);
            }
        }
    }, [branches, loadBranch]);

    // Auto-append new committed nodes when seqNum advances on the current branch
    const prevCommitRef = useRef({ branchNum: currentBranchNum, seqNum: currentSeqNum });
    useEffect(() => {
        const prev = prevCommitRef.current;
        const branchChanged = currentBranchNum !== prev.branchNum;
        prevCommitRef.current = { branchNum: currentBranchNum, seqNum: currentSeqNum };

        // On branch switch or uninitialized state, skip — loadBranch handles initial load
        if (branchChanged || !manager || prev.seqNum === 0 || currentSeqNum <= prev.seqNum) return;

        const fetchStart = prev.seqNum + 1;
        const fetchEnd = currentSeqNum;
        const branchNum = currentBranchNum;

        manager
            .fetchNodes(fetchStart, fetchEnd, branchNum)
            .then((data) => {
                if (data.nodes.length === 0) return;

                const formattedNewNodes = formatNodes(data.nodes, branchNum);

                setBranchData((prev) => {
                    const existing = prev.get(branchNum);
                    if (!existing) return prev; // not yet loaded; loadBranch will handle it

                    const next = new Map(prev);
                    next.set(branchNum, {
                        nodes: [...existing.nodes, ...formattedNewNodes],
                        lowestSeqLoaded: existing.lowestSeqLoaded,
                    });
                    return next;
                });
            })
            .catch((e) => console.error("HistoryTreeDriver auto-update:", e));
    }, [currentSeqNum, currentBranchNum, manager, setBranchData]);

    const treeData = useMemo(() => {
        const map = new Map<
            number,
            {
                nodes: VersionNode<NodeSummary>[];
                parent: { branch: number; seq: number } | null;
                headNode?: React.ReactNode;
            }
        >();

        for (const branch of branches) {
            const loaded = branchData.get(branch.branch_num);
            const branchNum = branch.branch_num;
            const headNode = (
                <div style={{ display: "flex", gap: "4px" }}>
                    <button
                        onClick={() => onCompareBranch?.(branchNum)}
                        style={{
                            flex: 1,
                            padding: "2px 4px",
                            fontSize: "10px",
                            cursor: "pointer",
                            borderRadius: "3px",
                            background: "#e8f4fd",
                            color: "#0066cc",
                            border: "1px solid #99ccee",
                        }}
                    >
                        Compare
                    </button>
                    <button
                        onClick={() => onOpenBranch?.(branchNum)}
                        style={{
                            flex: 1,
                            padding: "2px 4px",
                            fontSize: "10px",
                            cursor: "pointer",
                            borderRadius: "3px",
                            background: "#e8f8e8",
                            color: "#006600",
                            border: "1px solid #99cc99",
                        }}
                    >
                        Open
                    </button>
                </div>
            );
            map.set(branchNum, {
                nodes: loaded?.nodes ?? [],
                parent:
                    branch.parent_branch !== null && branch.parent_seq !== null
                        ? { branch: branch.parent_branch, seq: branch.parent_seq }
                        : null,
                headNode,
            });
        }
        return map;
    }, [branches, branchData, onCompareBranch, onOpenBranch]);

    const renderNode = useCallback(
        (node: VersionNode<NodeSummary>) => <HistoryTreeNode node={node} onForkHere={onForkHere} />,
        [onForkHere],
    );

    const centerAtNodeRef = useRef<{ branch: number; seq: number } | null>(null);
    if (currentSeqNum >= 1) {
        centerAtNodeRef.current = { branch: currentBranchNum, seq: currentSeqNum };
    }
    const centerAtNode = centerAtNodeRef.current;

    return (
        <div style={{ width: "100%", height: "100%" }}>
            <HistoryTree
                branches={treeData}
                renderNode={renderNode}
                onRequestMoreHistory={loadMoreHistory}
                centerAtNode={centerAtNode}
            />
        </div>
    );
}
