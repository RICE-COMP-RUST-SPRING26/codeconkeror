import type { ClientObservableState } from "../types";

function connBadgeClass(status: string) {
    if (status === "connected") return "bg-green-100 text-green-800";
    if (status === "error") return "bg-red-100 text-red-800";
    if (status === "connecting") return "bg-yellow-100 text-yellow-800";
    return "bg-gray-100 text-gray-800";
}

function shortId(id: string) {
    return id.slice(0, 8) + "…" + id.slice(-4);
}

interface StatusBarProps {
    state: ClientObservableState | null;
    label?: string;
}

export default function StatusBar({ state, label }: StatusBarProps) {
    if (!state) return null;
    return (
        <div className="text-xs font-mono text-gray-600 bg-white rounded px-2 py-2 flex items-center">
            {label && <span className="font-semibold text-gray-800 mr-2">{label}</span>}
            branch {state.branchNum} · seq {state.lastCommittedState.seqNum} · pending:{" "}
            {state.dispatched ? <span className="text-yellow-600 font-semibold">yes</span> : "no"} ·
            client {shortId(state.clientId)}
            <span className={`ml-auto px-2 py-0.5 rounded font-medium ${connBadgeClass(state.connStatus)}`}>
                {state.connStatus}
            </span>
        </div>
    );
}
