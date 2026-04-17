import React, { useState, useEffect, useRef, useCallback } from "react";
import { DocumentClient, createDocument, newClientId } from "./client";
import { buildDebugSegments, buildDiffSegments, summarizePatch } from "./ot";
import type { ClientObservableState, BranchSummary, NodeSummary, EventLogEntry } from "./types";

const SERVER_URL = "http://bore.pub:57009";
const LS_CLIENT = "branchedit.clientId";

function shortId(id: string) {
    return id.slice(0, 8) + "…" + id.slice(-4);
}

function fmtTime(d: Date) {
    return d.toTimeString().slice(0, 8);
}

export default function App() {
    const [clientId] = useState(() => {
        let id = sessionStorage.getItem(LS_CLIENT);
        if (!id) {
            id = newClientId();
            sessionStorage.setItem(LS_CLIENT, id);
        }
        return id;
    });

    const [docIdInput, setDocIdInput] = useState("");
    const [docId, setDocId] = useState<string | null>(null);

    const clientRef = useRef<DocumentClient | null>(null);
    const [clientState, setClientState] = useState<ClientObservableState | null>(null);

    const [branches, setBranches] = useState<BranchSummary[]>([]);

    const [debugMode, setDebugMode] = useState(false);
    const [showEventLog, setShowEventLog] = useState(false);
    const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
    const logCounter = useRef(0);

    const [showHistory, setShowHistory] = useState(false);
    const [historyNodes, setHistoryNodes] = useState<NodeSummary[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);

    const [sendDelay, setSendDelay] = useState(0);
    const autoInsertRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const autoInsertPosRef = useRef(0);
    const [isAutoInserting, setIsAutoInserting] = useState(false);

    const [shadowInput, setShadowInput] = useState("");
    const shadowClientRef = useRef<DocumentClient | null>(null);
    const [shadowBranchNum, setShadowBranchNum] = useState<number | null>(null);
    const [shadowState, setShadowState] = useState<ClientObservableState | null>(null);

    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const addEvent = useCallback((entry: Omit<EventLogEntry, "id" | "time">) => {
        setEventLog((prev) => [
            ...prev.slice(-199),
            { ...entry, id: ++logCounter.current, time: new Date() },
        ]);
    }, []);

    const openDocument = useCallback(
        (id: string, branch: number) => {
            clientRef.current?.disconnect();
            setClientState(null);
            setHistoryNodes([]);
            setShowHistory(false);

            const client = new DocumentClient({
                serverUrl: SERVER_URL,
                docId: id,
                branchNum: branch,
                clientId,
                onState: setClientState,
                onEvent: addEvent,
            });
            client.sendDelay = sendDelay;
            clientRef.current = client;
            client.connect();
            setDocId(id);
        },
        [clientId, addEvent, sendDelay],
    );

    const refreshBranches = useCallback(async () => {
        if (!clientRef.current) return;
        try {
            const data = await clientRef.current.listBranches();
            setBranches(data.branches);
        } catch (e) {
            console.error("refresh branches:", e);
        }
    }, []);

    // Hash-based routing
    useEffect(() => {
        const loadFromHash = () => {
            const h = location.hash.replace(/^#/, "").trim();
            if (/^[0-9a-f]{32}$/.test(h)) {
                setDocIdInput(h);
                openDocument(h, 0);
            }
        };
        window.addEventListener("hashchange", loadFromHash);
        loadFromHash();
        return () => window.removeEventListener("hashchange", loadFromHash);
    }, [openDocument]);

    // Auto-refresh branches after connect
    useEffect(() => {
        if (docId) void refreshBranches();
    }, [docId, refreshBranches]);

    const handleOpen = () => {
        const id = docIdInput.trim().toLowerCase();
        if (/^[0-9a-f]{32}$/.test(id)) location.hash = `#${id}`;
        else alert("Doc ID must be 32 hex characters");
    };

    const handleNew = async () => {
        try {
            const res = await createDocument(SERVER_URL, "hello world", { author: "webapp" });
            setDocIdInput(res.doc_id);
            location.hash = `#${res.doc_id}`;
        } catch (e) {
            alert("Failed to create document: " + (e as Error).message);
        }
    };

    const handleBranchChange = (n: number) => {
        if (!docId) return;
        openDocument(docId, n);
    };

    const handleFork = async () => {
        const client = clientRef.current;
        if (!client || !docId) return;
        try {
            const res = await client.createBranch(
                client.lastCommittedState.seqNum,
                client.branchNum,
            );
            await refreshBranches();
            openDocument(docId, res.branch_num);
        } catch (e) {
            alert("Fork failed: " + (e as Error).message);
        }
    };

    const handleEditorChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        if (!clientRef.current) return;
        void clientRef.current.userEdit(e.target.value);
    };

    // Keep cursor stable when the displayed content changes due to OT.
    const prevDisplayed = useRef("");
    useEffect(() => {
        const ta = textareaRef.current;
        const content = clientState?.displayedContent ?? "";
        if (!ta || content === prevDisplayed.current) return;
        prevDisplayed.current = content;
        if (ta.value !== content) {
            const sel = [ta.selectionStart, ta.selectionEnd];
            ta.value = content;
            try {
                ta.setSelectionRange(
                    Math.min(sel[0], content.length),
                    Math.min(sel[1], content.length),
                );
            } catch {
                /* ignore */
            }
        }
    }, [clientState?.displayedContent]);

    const loadHistory = async () => {
        const client = clientRef.current;
        const state = clientState;
        if (!client || !state) return;
        setHistoryLoading(true);
        try {
            const end = state.lastCommittedState.seqNum;
            if (end < 1) {
                setHistoryNodes([]);
                setShowHistory(true);
                return;
            }
            const data = await client.fetchNodes(1, end, state.branchNum);
            setHistoryNodes(data.nodes);
            setShowHistory(true);
        } catch (e) {
            alert("Failed to load history: " + (e as Error).message);
        } finally {
            setHistoryLoading(false);
        }
    };

    const forkFromNode = async (node: NodeSummary) => {
        const client = clientRef.current;
        if (!client || !docId || !clientState) return;
        try {
            const res = await client.createBranch(node.seq, clientState.branchNum);
            await refreshBranches();
            openDocument(docId, res.branch_num);
        } catch (e) {
            alert("Fork failed: " + (e as Error).message);
        }
    };

    const startShadowing = () => {
        const n = parseInt(shadowInput, 10);
        if (isNaN(n) || !docId) return;
        shadowClientRef.current?.disconnect();
        const shadowClient = new DocumentClient({
            serverUrl: SERVER_URL,
            docId,
            branchNum: n,
            clientId: newClientId(),
            onState: setShadowState,
            onEvent: () => {},
        });
        shadowClientRef.current = shadowClient;
        shadowClient.connect();
        setShadowBranchNum(n);
    };

    const stopShadowing = () => {
        shadowClientRef.current?.disconnect();
        shadowClientRef.current = null;
        setShadowBranchNum(null);
        setShadowState(null);
    };

    useEffect(() => {
        if (clientRef.current) clientRef.current.sendDelay = sendDelay;
    }, [sendDelay]);

    const LOREM_IPSUM =
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor " +
        "incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud " +
        "exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.";

    const toggleAutoInsert = useCallback(() => {
        if (autoInsertRef.current !== null) {
            clearInterval(autoInsertRef.current);
            autoInsertRef.current = null;
            setIsAutoInserting(false);
            return;
        }
        autoInsertPosRef.current = 0;
        setIsAutoInserting(true);
        autoInsertRef.current = setInterval(() => {
            const client = clientRef.current;
            if (!client) return;
            const pos = autoInsertPosRef.current;
            const current = client.displayedContent;
            void client.userEdit(current + LOREM_IPSUM[pos]);
            autoInsertPosRef.current = (pos + 1) % LOREM_IPSUM.length;
        }, 80);
    }, [LOREM_IPSUM]);

    useEffect(() => {
        return () => {
            clientRef.current?.disconnect();
            shadowClientRef.current?.disconnect();
        };
    }, []);

    const connBadgeClass = (status: string) => {
        if (status === "connected") return "bg-green-100 text-green-800";
        if (status === "error") return "bg-red-100 text-red-800";
        if (status === "connecting") return "bg-yellow-100 text-yellow-800";
        return "bg-gray-100 text-gray-800";
    };

    const currentBranchNum = clientState?.branchNum ?? 0;
    const headSeqByBranch = new Map(branches.map((b) => [b.branch_num, b.head_seq]));

    return (
        <div className="min-h-screen bg-gray-50">
            <div className="max-w-4xl mx-auto p-4">
                <h1 className="text-2xl font-bold mb-4 text-gray-800">BranchEdit</h1>

                {/* ── Doc controls ── */}
                <div className="flex gap-2 mb-2">
                    <input
                        type="text"
                        value={docIdInput}
                        onChange={(e) => setDocIdInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleOpen()}
                        placeholder="Doc id (32 hex chars)"
                        className="flex-1 border border-gray-300 rounded px-2 py-1 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                    />
                    <button
                        onClick={handleOpen}
                        className="px-3 py-1 bg-blue-500 hover:bg-blue-600 text-white rounded text-sm"
                    >
                        Open
                    </button>
                    <button
                        onClick={handleNew}
                        className="px-3 py-1 bg-green-500 hover:bg-green-600 text-white rounded text-sm"
                    >
                        New document
                    </button>
                </div>

                {/* ── Branch controls ── */}
                <div className="flex gap-2 mb-2 items-center flex-wrap">
                    <select
                        value={String(currentBranchNum)}
                        onChange={(e) => handleBranchChange(Number(e.target.value))}
                        className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none"
                    >
                        {branches.length === 0 ? (
                            <option value="0">#0</option>
                        ) : (
                            branches.map((b) => (
                                <option key={b.branch_num} value={String(b.branch_num)}>
                                    #{b.branch_num} · head {b.head_seq}
                                    {b.parent_branch != null
                                        ? ` · from #${b.parent_branch}@${b.parent_seq}`
                                        : ""}
                                </option>
                            ))
                        )}
                    </select>
                    <button
                        onClick={() => void refreshBranches()}
                        className="px-3 py-1 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded text-sm"
                    >
                        Refresh branches
                    </button>
                    <button
                        onClick={() => void handleFork()}
                        disabled={!docId}
                        className="px-3 py-1 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded text-sm disabled:opacity-40"
                    >
                        Fork from current seq
                    </button>
                    <div className="ml-auto">
                        {clientState && (
                            <span
                                className={`px-2 py-1 rounded text-sm font-medium ${connBadgeClass(clientState.connStatus)}`}
                            >
                                {clientState.connStatus}
                            </span>
                        )}
                    </div>
                </div>

                {/* ── Status line (ABOVE editor) ── */}
                {clientState && (
                    <div className="mb-2 text-xs font-mono text-gray-600 bg-white border border-gray-200 rounded px-2 py-1">
                        branch {clientState.branchNum} · seq {clientState.lastCommittedState.seqNum}{" "}
                        · pending:{" "}
                        {clientState.dispatched ? (
                            <span className="text-yellow-600 font-semibold">yes</span>
                        ) : (
                            "no"
                        )}{" "}
                        · client {shortId(clientState.clientId)}
                    </div>
                )}

                {/* ── Editor ── */}
                <textarea
                    ref={textareaRef}
                    defaultValue=""
                    onChange={handleEditorChange}
                    disabled={!clientState?.initialized}
                    spellCheck={false}
                    className="w-full h-64 border border-gray-300 rounded p-2 font-mono text-sm resize-y focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:bg-gray-100 disabled:text-gray-400"
                    placeholder={
                        docId
                            ? clientState?.initialized
                                ? ""
                                : "Connecting…"
                            : "Open or create a document to start editing"
                    }
                />

                {/* ── Checkboxes row ── */}
                <div className="flex gap-4 mt-2 text-sm items-center flex-wrap">
                    <label className="flex items-center gap-1 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={debugMode}
                            onChange={(e) => setDebugMode(e.target.checked)}
                            className="rounded"
                        />
                        Debug
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={showEventLog}
                            onChange={(e) => setShowEventLog(e.target.checked)}
                            className="rounded"
                        />
                        Event log
                    </label>
                    <label className="flex items-center gap-1 select-none">
                        Patch delay:
                        <input
                            type="number"
                            min={0}
                            step={100}
                            value={sendDelay}
                            onChange={(e) => setSendDelay(Math.max(0, Number(e.target.value)))}
                            className="w-20 border border-gray-300 rounded px-1 py-0.5 text-sm"
                        />
                        ms
                    </label>
                    <button
                        onClick={toggleAutoInsert}
                        disabled={!clientState?.initialized}
                        className={`px-3 py-1 rounded text-sm disabled:opacity-40 ${
                            isAutoInserting
                                ? "bg-red-100 hover:bg-red-200 border border-red-300 text-red-700"
                                : "bg-gray-100 hover:bg-gray-200 border border-gray-300"
                        }`}
                    >
                        {isAutoInserting ? "Stop auto insert" : "Auto insert"}
                    </button>
                </div>

                {/* ── Debug overlay ── */}
                {debugMode && clientState && (
                    <div className="mt-2 border border-gray-300 rounded bg-white p-3">
                        <p className="text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide">
                            Debug view
                        </p>
                        <div className="mb-2 text-xs">
                            <span className="inline-block w-3 h-3 bg-white border border-gray-300 rounded-sm mr-1" />
                            <span className="text-gray-600 mr-3">committed</span>
                            <span className="inline-block w-3 h-3 bg-yellow-200 rounded-sm mr-1" />
                            <span className="text-gray-600 mr-3">dispatched (pending)</span>
                            <span className="inline-block w-3 h-3 bg-blue-200 rounded-sm mr-1" />
                            <span className="text-gray-600">unsent (queued)</span>
                        </div>
                        <pre className="text-sm font-mono whitespace-pre-wrap break-all leading-relaxed border border-gray-100 rounded p-2 bg-gray-50">
                            {buildDebugSegments(
                                clientState.lastCommittedState.content,
                                clientState.rebasedDispatched,
                                clientState.queued,
                            ).map((seg, i) => (
                                <span
                                    key={i}
                                    className={
                                        seg.layer === "pending"
                                            ? "bg-yellow-200"
                                            : seg.layer === "queued"
                                              ? "bg-blue-200"
                                              : ""
                                    }
                                >
                                    {seg.text}
                                </span>
                            ))}
                        </pre>
                        <div className="mt-2 text-xs text-gray-500 space-y-1">
                            <div>
                                <span className="font-semibold">
                                    lastCommitted ({clientState.lastCommittedState.seqNum}):
                                </span>{" "}
                                <span className="font-mono">
                                    {JSON.stringify(
                                        clientState.lastCommittedState.content.slice(0, 80),
                                    )}
                                </span>
                            </div>
                            {clientState.rebasedDispatched && (
                                <div>
                                    <span className="font-semibold">dispatched patch:</span>{" "}
                                    <span className="font-mono">
                                        {summarizePatch(clientState.rebasedDispatched)}
                                    </span>
                                </div>
                            )}
                            <div>
                                <span className="font-semibold">queued patch:</span>{" "}
                                <span className="font-mono">
                                    {summarizePatch(clientState.queued)}
                                </span>
                            </div>
                        </div>
                    </div>
                )}

                {/* ── Shadow branch ── */}
                <div className="mt-3 border border-gray-200 rounded bg-white p-3">
                    <p className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">
                        Shadow branch
                    </p>
                    <div className="flex gap-2 items-center">
                        <input
                            type="number"
                            min={0}
                            value={shadowInput}
                            onChange={(e) => setShadowInput(e.target.value)}
                            placeholder="Branch #"
                            disabled={shadowBranchNum !== null}
                            className="w-24 border border-gray-300 rounded px-2 py-1 text-sm disabled:bg-gray-100"
                        />
                        {shadowBranchNum === null ? (
                            <button
                                onClick={startShadowing}
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
                                    className={`px-2 py-0.5 rounded text-xs font-medium ${connBadgeClass(shadowState?.connStatus ?? "disconnected")}`}
                                >
                                    {shadowState?.connStatus ?? "disconnected"}
                                </span>
                                <button
                                    onClick={stopShadowing}
                                    className="px-3 py-1 bg-gray-200 hover:bg-gray-300 rounded text-sm"
                                >
                                    Stop
                                </button>
                            </>
                        )}
                    </div>

                    {shadowBranchNum !== null &&
                        shadowState?.initialized &&
                        clientState?.initialized && (
                            <div className="mt-2">
                                <p className="text-xs text-gray-500 mb-1">
                                    Diff: current branch vs shadow branch #{shadowBranchNum} (
                                    <span className="text-green-700">green = added in current</span>
                                    ,{" "}
                                    <span className="text-red-700 line-through">
                                        red = removed from shadow
                                    </span>
                                    )
                                </p>
                                <pre className="text-sm font-mono whitespace-pre-wrap break-all leading-relaxed border border-gray-100 rounded p-2 bg-gray-50">
                                    {buildDiffSegments(
                                        shadowState.displayedContent,
                                        clientState.displayedContent,
                                    ).map((seg, i) => {
                                        if (seg.type === "same")
                                            return <span key={i}>{seg.text}</span>;
                                        if (seg.type === "added")
                                            return (
                                                <span
                                                    key={i}
                                                    className="bg-green-200 text-green-900"
                                                >
                                                    {seg.text}
                                                </span>
                                            );
                                        return (
                                            <span
                                                key={i}
                                                className="bg-red-200 text-red-900 line-through"
                                            >
                                                {seg.text}
                                            </span>
                                        );
                                    })}
                                </pre>
                            </div>
                        )}
                </div>

                {/* ── History ── */}
                <div className="mt-3">
                    <div className="flex gap-2 items-center">
                        <button
                            onClick={() =>
                                showHistory ? setShowHistory(false) : void loadHistory()
                            }
                            disabled={!clientState || historyLoading}
                            className="px-3 py-1 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded text-sm disabled:opacity-40"
                        >
                            {historyLoading
                                ? "Loading…"
                                : showHistory
                                  ? "Hide history"
                                  : "Show history"}
                        </button>
                        {showHistory && clientState && (
                            <span className="text-xs text-gray-500">
                                {historyNodes.length} nodes on branch {clientState.branchNum}
                            </span>
                        )}
                    </div>

                    {showHistory && (
                        <div className="mt-2 border border-gray-200 rounded bg-white overflow-hidden">
                            {historyNodes.length === 0 ? (
                                <p className="text-sm text-gray-500 p-3">(empty)</p>
                            ) : (
                                <ul className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
                                    {historyNodes.map((node) => {
                                        const isHead =
                                            headSeqByBranch.get(currentBranchNum) === node.seq;
                                        const branchWithThisHead = branches.find(
                                            (b) =>
                                                b.head_seq === node.seq &&
                                                b.branch_num !== currentBranchNum,
                                        );
                                        const author =
                                            (node.metadata?.author as string | undefined) ?? "";
                                        const ts = node.timestamp
                                            ? new Date(node.timestamp * 1000)
                                                  .toISOString()
                                                  .replace("T", " ")
                                                  .slice(0, 19)
                                            : "";

                                        return (
                                            <li
                                                key={node.seq}
                                                className="px-3 py-2 text-xs flex items-start gap-3"
                                            >
                                                <span className="font-mono text-gray-400 w-10 flex-shrink-0 mt-0.5">
                                                    {String(node.seq).padStart(4, "0")}
                                                </span>
                                                <div className="flex-1 min-w-0">
                                                    <div className="font-mono text-gray-700 truncate">
                                                        {summarizePatch(node.patch)}
                                                    </div>
                                                    <div className="text-gray-400 mt-0.5">
                                                        {ts}
                                                        {author ? ` · ${author}` : ""}
                                                    </div>
                                                </div>
                                                <div className="flex-shrink-0 flex gap-1">
                                                    {isHead ? (
                                                        <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">
                                                            head
                                                        </span>
                                                    ) : branchWithThisHead ? (
                                                        <button
                                                            onClick={() => {
                                                                if (docId)
                                                                    openDocument(
                                                                        docId,
                                                                        branchWithThisHead.branch_num,
                                                                    );
                                                            }}
                                                            className="px-2 py-0.5 bg-indigo-100 hover:bg-indigo-200 text-indigo-700 rounded text-xs"
                                                        >
                                                            Switch to #
                                                            {branchWithThisHead.branch_num}
                                                        </button>
                                                    ) : (
                                                        <button
                                                            onClick={() => void forkFromNode(node)}
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

                {/* ── Event log ── */}
                {showEventLog && (
                    <div className="mt-3 border border-gray-200 rounded bg-white overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 bg-gray-50">
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                                Event log
                            </p>
                            <button
                                onClick={() => setEventLog([])}
                                className="text-xs text-gray-400 hover:text-gray-600"
                            >
                                Clear
                            </button>
                        </div>
                        {eventLog.length === 0 ? (
                            <p className="text-sm text-gray-400 p-3">(no events yet)</p>
                        ) : (
                            <ul className="max-h-52 overflow-y-auto divide-y divide-gray-50">
                                {[...eventLog].reverse().map((entry) => (
                                    <li
                                        key={entry.id}
                                        className="px-3 py-1 text-xs font-mono flex gap-3 items-baseline"
                                    >
                                        <span className="text-gray-400 flex-shrink-0">
                                            {fmtTime(entry.time)}
                                        </span>
                                        <span
                                            className={`flex-shrink-0 font-semibold ${
                                                entry.direction === "in"
                                                    ? "text-blue-600"
                                                    : "text-orange-600"
                                            }`}
                                        >
                                            {entry.direction === "in" ? "←" : "→"} {entry.type}
                                        </span>
                                        <span className="text-gray-600 truncate">
                                            {entry.detail}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
