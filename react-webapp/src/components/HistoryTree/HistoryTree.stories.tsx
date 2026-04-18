import React, { useState, useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { HistoryTree, HistoryTreeProps, VersionNode } from "./HistoryTree";

type CommitValue = { message: string };

const meta: Meta<typeof HistoryTree> = {
    title: "Components/HistoryTree",
    component: HistoryTree,
};
export default meta;

type Story = StoryObj<typeof HistoryTree<CommitValue>>;

const createNode = (seq: number, message: string): VersionNode<CommitValue> => ({
    seq,
    value: { message },
    timestamp: new Date(),
    username: "u" + seq,
});

export const ComprehensiveMockFramework: Story = {
    render: () => {
        // 1. Define the full absolute state of the repository history
        const fullDatabase = useMemo(() => {
            const db = new Map<
                number,
                {
                    nodes: VersionNode<CommitValue>[];
                    parent: { branch: number; seq: number } | null;
                }
            >();

            // Root branch
            db.set(0, {
                parent: null,
                nodes: Array.from({ length: 12 }, (_, i) =>
                    createNode(i + 1, `Main Commit ${i + 1}`),
                ),
            });

            // Early Branch - Will be pushed further to the right to avoid edge overlap
            db.set(1, {
                parent: { branch: 0, seq: 2 },
                nodes: Array.from({ length: 8 }, (_, i) =>
                    createNode(i + 3, `Early Feat ${i + 3}`),
                ),
            });

            // Middle Branch
            db.set(2, {
                parent: { branch: 0, seq: 5 },
                nodes: Array.from({ length: 6 }, (_, i) => createNode(i + 6, `Refactor ${i + 6}`)),
            });

            // Late Branch - Will be placed physically closest to root branch
            db.set(5, {
                parent: { branch: 0, seq: 9 },
                nodes: Array.from({ length: 3 }, (_, i) =>
                    createNode(i + 10, `Release Prep ${i + 10}`),
                ),
            });

            // Sub-branch derived from Branch 1
            db.set(3, {
                parent: { branch: 1, seq: 7 },
                nodes: Array.from({ length: 5 }, (_, i) =>
                    createNode(i + 8, `Feat Patch ${i + 8}`),
                ),
            });

            // Sub-branch derived from Branch 2
            db.set(4, {
                parent: { branch: 2, seq: 8 },
                nodes: Array.from({ length: 4 }, (_, i) =>
                    createNode(i + 9, `Experiment X ${i + 9}`),
                ),
            });

            return db;
        }, []);

        // 2. Initialize the UI with only the last 3 nodes of every branch
        const [branches, setBranches] = useState<HistoryTreeProps<CommitValue>["branches"]>(() => {
            const initial = new Map();
            fullDatabase.forEach((branchData, branchId) => {
                initial.set(branchId, {
                    parent: branchData.parent,
                    nodes: branchData.nodes.slice(-3), // Only the latest 3 nodes
                });
            });
            return initial;
        });

        // 3. Handle data loading dynamically
        const handleRequestMoreHistory = (branchId: number) => {
            setTimeout(() => {
                setBranches((prev) => {
                    const newBranches = new Map(prev);
                    const currentVisibleNodes = prev.get(branchId)?.nodes || [];
                    const fullBranchNodes = fullDatabase.get(branchId)?.nodes || [];

                    const currentLength = currentVisibleNodes.length;
                    // Load 2 more from the full history array
                    const nextLength = Math.min(currentLength + 2, fullBranchNodes.length);

                    newBranches.set(branchId, {
                        parent: fullDatabase.get(branchId)?.parent || null,
                        nodes: fullBranchNodes.slice(-nextLength),
                    });

                    return newBranches;
                });
            }, 800); // Simulate network delay
        };

        return (
            <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
                <div style={{ flex: 1, position: "relative" }}>
                    <HistoryTree<CommitValue>
                        branches={branches}
                        onRequestMoreHistory={handleRequestMoreHistory}
                        renderNode={(node) => (
                            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <strong
                                    style={{
                                        fontSize: "11px",
                                        lineHeight: "1.2",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                    }}
                                >
                                    {node.value.message}
                                </strong>
                                <span style={{ fontSize: "9px", color: "#666" }}>
                                    #{node.seq} | {node.username}
                                </span>
                            </div>
                        )}
                    />
                </div>
            </div>
        );
    },
};
