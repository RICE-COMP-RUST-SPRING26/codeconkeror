import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
    ReactFlow,
    ReactFlowProvider,
    Handle,
    Position,
    useReactFlow,
    NodeProps,
    EdgeProps,
    Node as FlowNode,
    Edge as FlowEdge,
    Background,
    Controls,
    Panel,
    MarkerType,
    BaseEdge,
    EdgeLabelRenderer,
    getSmoothStepPath,
    getStraightPath,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

// --- Global Layout Constants ---
export const VERTICAL_SPACING = 45;
export const HORIZONTAL_SPACING = 160;

export type VersionNode<T> = {
    seq: number;
    value: T;
    timestamp: Date;
    username: any;
};

export type HistoryTreeProps<T> = {
    branches: Map<
        number,
        {
            nodes: VersionNode<T>[];
            parent: { branch: number; seq: number } | null;
        }
    >;
    renderNode: (node: VersionNode<T>) => React.ReactNode;
    onRequestMoreHistory: (branch: number) => void;
    centerAtNode?: { branch: number; seq: number } | null;
};

// --- Custom Edge with Inline Button ---

const GapEdge = ({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    markerEnd,
    data,
}: EdgeProps) => {
    const isStraight = data?.isStraight as boolean;
    const [edgePath] = isStraight
        ? getStraightPath({ sourceX, sourceY, targetX, targetY })
        : getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });

    // Position the label directly above the target node (the first loaded node)
    const labelX = targetX;
    const labelY = targetY - 12;

    return (
        <>
            <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
            <EdgeLabelRenderer>
                <div
                    style={{
                        position: "absolute",
                        transform: `translate(-50%, -100%) translate(${labelX}px,${labelY}px)`,
                        pointerEvents: "all",
                    }}
                    className="nodrag nopan"
                >
                    <button
                        disabled={data?.isLoading as boolean}
                        onClick={data?.onClick as () => void}
                        style={{
                            padding: "2px 8px",
                            fontSize: "10px",
                            fontWeight: "bold",
                            cursor: data?.isLoading ? "not-allowed" : "pointer",
                            borderRadius: "12px",
                            background: data?.isLoading ? "#e9ecef" : "#fff",
                            color: data?.isLoading ? "#6c757d" : "#007bff",
                            border: "1px solid #007bff",
                            boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
                            whiteSpace: "nowrap",
                        }}
                    >
                        {data?.isLoading ? "..." : "↑ Load older"}
                    </button>
                </div>
            </EdgeLabelRenderer>
        </>
    );
};

// --- Custom Node Components ---

const NODE_STYLE: React.CSSProperties = {
    width: "130px",
    boxSizing: "border-box",
    borderRadius: "4px",
    padding: "6px 8px",
    position: "relative",
};

const CompactHandle = ({
    type,
    position,
    id,
    color,
}: {
    type: "source" | "target";
    position: Position;
    id: string;
    color: string;
}) => (
    <Handle
        type={type}
        position={position}
        id={id}
        style={{
            background: color,
            width: "6px",
            height: "6px",
            minWidth: "auto",
            minHeight: "auto",
        }}
    />
);

const CommitNode = ({ data }: NodeProps) => {
    return (
        <div style={{ ...NODE_STYLE, background: "#fff", border: "1px solid #333" }}>
            <CompactHandle type="target" position={Position.Top} id="top" color="#555" />
            {/* @ts-ignore */}
            {data.renderNode(data.nodeData)}
            <CompactHandle type="source" position={Position.Bottom} id="bottom" color="#555" />
            <CompactHandle type="source" position={Position.Right} id="right" color="#007bff" />
        </div>
    );
};

const DummyNode = ({ data }: NodeProps) => {
    return (
        <div
            style={{
                ...NODE_STYLE,
                background: "#f8f9fa",
                border: "1px dashed #adb5bd",
                color: "#6c757d",
                textAlign: "center",
            }}
        >
            <CompactHandle type="target" position={Position.Top} id="top" color="transparent" />
            <div style={{ fontSize: "10px", fontWeight: "bold" }}>Not Loaded</div>
            <div style={{ fontSize: "9px" }}>Seq: {data.seq as number}</div>
            <CompactHandle
                type="source"
                position={Position.Bottom}
                id="bottom"
                color="transparent"
            />
            <CompactHandle type="source" position={Position.Right} id="right" color="transparent" />
        </div>
    );
};

const nodeTypes = {
    commit: CommitNode,
    dummy: DummyNode,
};

const edgeTypes = {
    gapEdge: GapEdge,
};

// --- Inner Component (Consumes ReactFlow context) ---

function HistoryTreeInner<T>({
    branches,
    renderNode,
    onRequestMoreHistory,
    centerAtNode,
}: HistoryTreeProps<T>) {
    const { setCenter } = useReactFlow();
    const [loadingBranches, setLoadingBranches] = useState<Set<number>>(new Set());

    console.log(centerAtNode);

    useEffect(() => {
        setLoadingBranches(new Set());
    }, [branches]);

    const { flowNodes, flowEdges, branchXMap, nodeYMap } = useMemo(() => {
        const branchEntries = Array.from(branches.entries());

        // 1. Calculate Tree Traversal Order (DFS)
        const childrenMap = new Map<number, number[]>();
        const rootIds: number[] = [];

        branchEntries.forEach(([id, branch]) => {
            if (!branch.parent) {
                rootIds.push(id);
            } else {
                const pid = branch.parent.branch;
                if (!childrenMap.has(pid)) childrenMap.set(pid, []);
                childrenMap.get(pid)!.push(id);
            }
        });

        childrenMap.forEach((children) => {
            children.sort((a, b) => {
                const seqA = branches.get(a)!.parent!.seq;
                const seqB = branches.get(b)!.parent!.seq;
                return seqA !== seqB ? seqB - seqA : a - b;
            });
        });

        const orderedBranchIds: number[] = [];
        const visited = new Set<number>();

        const dfs = (id: number) => {
            if (visited.has(id)) return;
            visited.add(id);
            orderedBranchIds.push(id);
            (childrenMap.get(id) || []).forEach(dfs);
        };

        rootIds.sort((a, b) => a - b).forEach(dfs);
        branchEntries.forEach(([id]) => dfs(id));

        const xMap = new Map<number, number>();
        orderedBranchIds.forEach((id, index) => {
            xMap.set(id, index * HORIZONTAL_SPACING);
        });

        // 2. Identify all sequences that exist within each branch (loaded + dummy)
        const branchSeqs = new Map<number, Set<number>>();
        branchEntries.forEach(([id, branch]) => {
            if (!branchSeqs.has(id)) branchSeqs.set(id, new Set());
            branch.nodes.forEach((n) => branchSeqs.get(id)!.add(n.seq));

            const firstSeq =
                branch.nodes.length > 0 ? Math.min(...branch.nodes.map((n) => n.seq)) : 1;

            if (!branch.parent) {
                if (firstSeq > 1) branchSeqs.get(id)!.add(1);
            } else {
                if (!branchSeqs.has(branch.parent.branch))
                    branchSeqs.set(branch.parent.branch, new Set());
                branchSeqs.get(branch.parent.branch)!.add(branch.parent.seq);
            }
        });

        // 3. Calculate Independent Y-coordinates per branch using strictly uniform spacing
        const computedYMap = new Map<string, number>();

        orderedBranchIds.forEach((branchId) => {
            const branch = branches.get(branchId)!;
            const seqs = Array.from(branchSeqs.get(branchId) || []).sort((a, b) => a - b);
            if (seqs.length === 0) return;

            let currentY = 0;

            if (branch.parent) {
                // Anchor this branch relative to its parent's exact Y-coordinate,
                // stepping down by exactly 1 standard block.
                const parentY =
                    computedYMap.get(`${branch.parent.branch}_${branch.parent.seq}`) || 0;
                currentY = parentY + VERTICAL_SPACING;
            }

            seqs.forEach((seq, index) => {
                if (index > 0) {
                    // Uniformly step down for every node in the local branch sequence
                    currentY += VERTICAL_SPACING;
                }
                computedYMap.set(`${branchId}_${seq}`, currentY);
            });
        });

        // 4. Build Flow Nodes
        const nodes: FlowNode[] = [];
        branchSeqs.forEach((seqs, branchId) => {
            const branchX = xMap.get(branchId)!;
            const branch = branches.get(branchId);
            const loadedNodesMap = new Map();
            branch?.nodes.forEach((n) => loadedNodesMap.set(n.seq, n));

            seqs.forEach((seq) => {
                const y = computedYMap.get(`${branchId}_${seq}`)!;
                if (loadedNodesMap.has(seq)) {
                    nodes.push({
                        id: `commit_${branchId}_${seq}`,
                        type: "commit",
                        position: { x: branchX, y },
                        data: { nodeData: loadedNodesMap.get(seq), renderNode },
                    });
                } else {
                    const isRoot = !branch?.parent && seq === 1;
                    nodes.push({
                        id: `dummy_${branchId}_${seq}`,
                        type: "dummy",
                        position: { x: branchX, y },
                        data: { seq, isRoot },
                    });
                }
            });
        });

        // 5. Build Flow Edges
        const edges: FlowEdge[] = [];
        branchEntries.forEach(([branchId, branch]) => {
            const sortedNodes = [...branch.nodes].sort((a, b) => a.seq - b.seq);
            const firstNode = sortedNodes[0];
            if (!firstNode) return;

            if (!branch.parent && firstNode.seq > 1) {
                edges.push({
                    id: `edge_gap_root_${branchId}`,
                    source: `dummy_${branchId}_1`,
                    sourceHandle: "bottom",
                    target: `commit_${branchId}_${firstNode.seq}`,
                    targetHandle: "top",
                    type: "gapEdge",
                    style: { strokeWidth: 2, stroke: "#adb5bd", strokeDasharray: "4 4" },
                    data: {
                        isStraight: true,
                        isLoading: loadingBranches.has(branchId),
                        onClick: () => {
                            setLoadingBranches((prev) => new Set(prev).add(branchId));
                            onRequestMoreHistory(branchId);
                        },
                    },
                });
            }

            sortedNodes.forEach((node, idx) => {
                if (idx > 0) {
                    const prevNode = sortedNodes[idx - 1];
                    edges.push({
                        id: `edge_${branchId}_${prevNode.seq}_to_${node.seq}`,
                        source: `commit_${branchId}_${prevNode.seq}`,
                        sourceHandle: "bottom",
                        target: `commit_${branchId}_${node.seq}`,
                        targetHandle: "top",
                        type: "straight",
                        style: { strokeWidth: 2, stroke: "#343a40" },
                    });
                }
            });

            if (branch.parent) {
                const parentBranch = branches.get(branch.parent.branch);
                const parentNodeExists = parentBranch?.nodes.some(
                    (n) => n.seq === branch.parent!.seq,
                );
                const actualParentId = parentNodeExists
                    ? `commit_${branch.parent.branch}_${branch.parent.seq}`
                    : `dummy_${branch.parent.branch}_${branch.parent.seq}`;

                const isFullyLoaded = firstNode.seq === branch.parent.seq + 1;

                edges.push({
                    id: `edge_parent_to_${branchId}`,
                    source: actualParentId,
                    sourceHandle: "right",
                    target: `commit_${branchId}_${firstNode.seq}`,
                    targetHandle: "top",
                    type: isFullyLoaded ? "smoothstep" : "gapEdge",
                    style: {
                        strokeWidth: 2,
                        stroke: isFullyLoaded ? "#007bff" : "#adb5bd",
                        strokeDasharray: isFullyLoaded ? "none" : "4 4",
                    },
                    markerEnd: isFullyLoaded
                        ? { type: MarkerType.ArrowClosed, color: "#007bff" }
                        : undefined,
                    data: isFullyLoaded
                        ? undefined
                        : {
                              isStraight: false,
                              isLoading: loadingBranches.has(branchId),
                              onClick: () => {
                                  setLoadingBranches((prev) => new Set(prev).add(branchId));
                                  onRequestMoreHistory(branchId);
                              },
                          },
                });
            }
        });

        return { flowNodes: nodes, flowEdges: edges, branchXMap: xMap, nodeYMap: computedYMap };
    }, [branches, renderNode, loadingBranches, onRequestMoreHistory]);

    useEffect(() => {
        if (centerAtNode) {
            const x = branchXMap.get(centerAtNode.branch);
            const y = nodeYMap.get(`${centerAtNode.branch}_${centerAtNode.seq}`);
            if (x !== undefined && y !== undefined) {
                setCenter(x + 65, y + 30, { zoom: 1, duration: 800 });
            }
        }
    }, [centerAtNode?.branch, centerAtNode?.seq]);

    const focusBranch = useCallback(
        (branchId: number) => {
            const branch = branches.get(branchId);
            if (!branch || branch.nodes.length === 0) return;
            const tipNode = branch.nodes.reduce((max, node) => (node.seq > max.seq ? node : max));
            const x = branchXMap.get(branchId);
            const y = nodeYMap.get(`${branchId}_${tipNode.seq}`);
            if (x !== undefined && y !== undefined) {
                setCenter(x + 65, y + 30, { zoom: 1, duration: 800 });
            }
        },
        [branches, branchXMap, nodeYMap, setCenter],
    );

    return (
        <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView={!centerAtNode}
        >
            <Background />
            <Controls />

            <Panel
                position="top-left"
                style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                    background: "rgba(255,255,255,0.95)",
                    padding: "10px",
                    borderRadius: "6px",
                    border: "1px solid #ddd",
                    maxHeight: "90vh",
                    overflowY: "auto",
                }}
            >
                <strong style={{ fontSize: "0.85em", marginBottom: "2px" }}>Focus Branch</strong>
                {Array.from(branches.entries())
                    .sort((a, b) => a[0] - b[0])
                    .map(([branchId, branch]) => {
                        const label = branch.parent
                            ? `Branch #${branchId} from #${branch.parent.branch}@${branch.parent.seq}`
                            : `Branch #${branchId}`;

                        return (
                            <button
                                key={branchId}
                                onClick={() => focusBranch(branchId)}
                                style={{
                                    padding: "4px 8px",
                                    textAlign: "left",
                                    background: "#f8f9fa",
                                    border: "1px solid #ced4da",
                                    borderRadius: "4px",
                                    cursor: "pointer",
                                    fontSize: "0.75em",
                                }}
                            >
                                {label}
                            </button>
                        );
                    })}
            </Panel>
        </ReactFlow>
    );
}

export function HistoryTree<T>(props: HistoryTreeProps<T>) {
    return (
        <div style={{ width: "100%", height: "100%", minHeight: "600px", background: "#fafafa" }}>
            <ReactFlowProvider>
                <HistoryTreeInner {...props} />
            </ReactFlowProvider>
        </div>
    );
}
