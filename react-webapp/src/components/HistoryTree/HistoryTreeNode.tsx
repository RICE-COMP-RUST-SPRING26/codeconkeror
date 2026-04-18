import type { NodeSummary, Patch } from "../../types";
import type { VersionNode } from "./HistoryTree";
import ForkIcon from "../../assets/fork.svg";

function compactPatchSummary(patch: Patch): string {
    const parts: string[] = [];
    for (const op of patch.ops) {
        if ("retain" in op) continue;
        else if ("insert" in op) {
            parts.push(`ins "${op.insert.replace(/\n/g, "\\n")}"`);
        } else if ("delete" in op) {
            parts.push(`del ${op.delete}`);
        }
    }
    const full = parts.join(" / ") || "(identity)";
    return full.length > 10 ? full.slice(0, 10) + "…" : full;
}

interface HistoryTreeNodeProps {
    node: VersionNode<NodeSummary>;
    onForkHere: (node: NodeSummary) => void;
}

export default function HistoryTreeNode({ node, onForkHere }: HistoryTreeNodeProps) {
    return (
        <div style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "9px" }}>
            <span style={{ fontFamily: "monospace", color: "#888", flexShrink: 0 }}>
                {String(node.seq).padStart(4, "0")}
            </span>
            <span
                style={{
                    fontFamily: "monospace",
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "#333",
                }}
            >
                {compactPatchSummary(node.value.patch)}
            </span>
            <button
                onClick={(e) => {
                    e.stopPropagation();
                    onForkHere(node.value);
                }}
                title="Fork here"
                style={{
                    padding: 0,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    flexShrink: 0,
                    opacity: 0.6,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.6")}
            >
                <img src={ForkIcon} alt="fork" style={{ width: "10px", height: "10px" }} />
            </button>
        </div>
    );
}
