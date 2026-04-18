import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ClientDocumentManager, createDocument, newClientId } from "./DocumentManager";
import type { ClientObservableState, BranchSummary, NodeSummary, EventLogEntry } from "./types";

import DocControls from "./components/DocControls";
import BranchControls from "./components/BranchControls";
import StatusBar from "./components/StatusBar";
import ShadowControls from "./components/ShadowControls";
import DebugPanel from "./components/DebugPanel";
import HistoryPanel from "./components/HistoryPanel";
import EventLogPanel from "./components/EventLogPanel";
import { CodeEditorWithDiff } from "./components/CodeEditorWithDiff/CodeEditorWithDiff";
import type { Cursor } from "./components/CodeEditorWithDiff/CodeEditorWithDiff";
import Logo from "./assets/Logo2.png";

const SERVER_URL = "http://bore.pub:21213";
const LS_CLIENT = "branchedit.clientId";
const LS_NAME = "branchedit.name";

const LOREM_IPSUM =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor " +
    "incididunt ut labore et dolore magna aliqua.\n" +
    "Ut enim ad minim veniam, quis nostrud " +
    "exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.\n";

export default function App() {
    const [clientId] = useState(() => {
        let id = sessionStorage.getItem(LS_CLIENT);
        if (!id) {
            id = newClientId();
            sessionStorage.setItem(LS_CLIENT, id);
        }
        return id;
    });

    const [name, setName] = useState(() => localStorage.getItem(LS_NAME) ?? "");
    const [docIdInput, setDocIdInput] = useState("");
    const [docId, setDocId] = useState<string | null>(null);
    const [branches, setBranches] = useState<BranchSummary[]>([]);

    const managerRef = useRef<ClientDocumentManager | null>(null);
    const [mainState, setMainState] = useState<ClientObservableState | null>(null);

    const shadowManagerRef = useRef<ClientDocumentManager | null>(null);
    const [shadowState, setShadowState] = useState<ClientObservableState | null>(null);
    const [shadowInput, setShadowInput] = useState("");
    const [shadowBranchNum, setShadowBranchNum] = useState<number | null>(null);

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

    const addEvent = useCallback((entry: Omit<EventLogEntry, "id" | "time">) => {
        setEventLog((prev) => [
            ...prev.slice(-199),
            { ...entry, id: ++logCounter.current, time: new Date() },
        ]);
    }, []);

    const openDocument = useCallback(
        (id: string, branch: number) => {
            managerRef.current?.disconnect();
            setMainState(null);
            setHistoryNodes([]);
            setShowHistory(false);

            const manager = new ClientDocumentManager({
                serverUrl: SERVER_URL,
                docId: id,
                branchNum: branch,
                clientId,
                name,
                onState: setMainState,
                onEvent: addEvent,
            });
            manager.sendDelay = sendDelay;
            managerRef.current = manager;
            manager.connect();
            setDocId(id);
        },
        [clientId, name, addEvent, sendDelay],
    );

    const refreshBranches = useCallback(async () => {
        const manager = managerRef.current;
        if (!manager) return;
        try {
            const data = await manager.listBranches();
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

    useEffect(() => {
        if (docId) void refreshBranches();
    }, [docId, refreshBranches]);

    // Keep name in sync on manager and persist to localStorage
    useEffect(() => {
        localStorage.setItem(LS_NAME, name);
        if (managerRef.current) managerRef.current.name = name;
        if (shadowManagerRef.current) shadowManagerRef.current.name = name;
    }, [name]);

    // Keep sendDelay in sync
    useEffect(() => {
        if (managerRef.current) managerRef.current.sendDelay = sendDelay;
    }, [sendDelay]);

    const handleOpen = () => {
        const id = docIdInput.trim().toLowerCase();
        if (/^[0-9a-f]{32}$/.test(id)) location.hash = `#${id}`;
        else alert("Doc ID must be 32 hex characters");
    };

    const handleNew = async () => {
        try {
            const res = await createDocument(SERVER_URL, "hello world", { name });
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
        const manager = managerRef.current;
        if (!manager || !docId || !mainState) return;
        try {
            const res = await manager.createBranch(
                mainState.lastCommittedState.seqNum,
                mainState.branchNum,
            );
            await refreshBranches();
            openDocument(docId, res.branch_num);
        } catch (e) {
            alert("Fork failed: " + (e as Error).message);
        }
    };

    const loadHistory = async () => {
        const manager = managerRef.current;
        if (!manager || !mainState) return;
        if (!showHistory) {
            setHistoryLoading(true);
            try {
                const end = mainState.lastCommittedState.seqNum;
                if (end < 1) {
                    setHistoryNodes([]);
                    setShowHistory(true);
                    return;
                }
                const data = await manager.fetchNodes(1, end, mainState.branchNum);
                setHistoryNodes(data.nodes);
                setShowHistory(true);
            } catch (e) {
                alert("Failed to load history: " + (e as Error).message);
            } finally {
                setHistoryLoading(false);
            }
        } else {
            setShowHistory(false);
        }
    };

    const forkFromNode = async (node: NodeSummary) => {
        const manager = managerRef.current;
        if (!manager || !docId || !mainState) return;
        try {
            const res = await manager.createBranch(node.seq, mainState.branchNum);
            await refreshBranches();
            openDocument(docId, res.branch_num);
        } catch (e) {
            alert("Fork failed: " + (e as Error).message);
        }
    };

    const startShadowing = () => {
        const n = parseInt(shadowInput, 10);
        if (isNaN(n) || !docId) return;
        shadowManagerRef.current?.disconnect();
        const shadowManager = new ClientDocumentManager({
            serverUrl: SERVER_URL,
            docId,
            branchNum: n,
            clientId: newClientId(),
            name,
            onState: setShadowState,
            onEvent: () => {},
        });
        shadowManagerRef.current = shadowManager;
        shadowManager.connect();
        setShadowBranchNum(n);
    };

    const stopShadowing = () => {
        shadowManagerRef.current?.disconnect();
        shadowManagerRef.current = null;
        setShadowBranchNum(null);
        setShadowState(null);
    };

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
            const manager = managerRef.current;
            if (!manager) return;
            const pos = autoInsertPosRef.current;
            const current = manager.displayedContent;
            void manager.setCurrentState(current + LOREM_IPSUM[pos], current.length + 1);
            autoInsertPosRef.current = (pos + 1) % LOREM_IPSUM.length;
        }, 80);
    }, []);

    useEffect(() => {
        return () => {
            managerRef.current?.disconnect();
            shadowManagerRef.current?.disconnect();
        };
    }, []);

    const currentBranchNum = mainState?.branchNum ?? 0;

    const toCursors = useCallback((state: ClientObservableState | null): Cursor[] => {
        if (!state) return [];
        return Array.from(state.externalCursors.entries()).map(([clientId, cursor]) => ({
            label: (cursor.metadata.name as string) || clientId.slice(0, 8),
            pos: cursor.pos,
        }));
    }, []);

    const diffProp = useMemo(() => {
        if (shadowBranchNum === null || !shadowState?.initialized) return null;
        return { code: shadowState.displayedContent, cursors: toCursors(shadowState) };
    }, [shadowBranchNum, shadowState, toCursors]);

    return (
        <div className="min-h-screen bg-gray-50">
            <div className="max-w-6xl mx-auto p-4">
                <img src={Logo} className="h-12 my-2" />

                <div className="flex flex-col gap-2 mb-3">
                    <DocControls
                        docIdInput={docIdInput}
                        name={name}
                        onDocIdChange={setDocIdInput}
                        onNameChange={setName}
                        onOpen={handleOpen}
                        onNew={() => void handleNew()}
                    />

                    <BranchControls
                        branches={branches}
                        currentBranchNum={currentBranchNum}
                        docId={docId}
                        state={mainState}
                        onBranchChange={handleBranchChange}
                        onRefresh={() => void refreshBranches()}
                        onFork={() => void handleFork()}
                    />
                </div>

                {/* Editor area */}
                <div className="mb-3">
                    <StatusBar state={mainState} />
                    <div className="h-[600px]">
                        <CodeEditorWithDiff
                            code={mainState?.displayedContent ?? ""}
                            cursors={toCursors(mainState)}
                            onChange={(content, cursor) => managerRef.current?.setCurrentState(content, cursor ?? mainState?.cursor ?? 0)}
                            onCursorMove={(cursor) => managerRef.current?.setCursor(cursor ?? 0)}
                            diff={diffProp}
                        />
                    </div>
                </div>

                {/* Toolbar */}
                <div className="flex gap-4 mb-3 text-sm items-center flex-wrap">
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
                        disabled={!mainState?.initialized}
                        className={`px-3 py-1 rounded text-sm disabled:opacity-40 ${
                            isAutoInserting
                                ? "bg-red-100 hover:bg-red-200 border border-red-300 text-red-700"
                                : "bg-gray-100 hover:bg-gray-200 border border-gray-300"
                        }`}
                    >
                        {isAutoInserting ? "Stop auto insert" : "Auto insert"}
                    </button>
                </div>

                {/* Shadow controls */}
                <div className="mb-3 p-2 border border-gray-200 rounded bg-white">
                    <ShadowControls
                        shadowInput={shadowInput}
                        shadowBranchNum={shadowBranchNum}
                        shadowState={shadowState}
                        docId={docId}
                        branches={branches}
                        currentBranchNum={currentBranchNum}
                        onInputChange={setShadowInput}
                        onStart={startShadowing}
                        onStop={stopShadowing}
                    />
                </div>

                {/* Debug panel */}
                {debugMode && mainState && (
                    <div className="mb-3">
                        <DebugPanel state={mainState} />
                    </div>
                )}

                {/* History */}
                <div className="mb-3">
                    <HistoryPanel
                        nodes={historyNodes}
                        branches={branches}
                        currentBranchNum={currentBranchNum}
                        loading={historyLoading}
                        visible={showHistory}
                        onToggle={() => void loadHistory()}
                        onForkHere={(node) => void forkFromNode(node)}
                        onSwitchBranch={(n) => {
                            if (docId) openDocument(docId, n);
                        }}
                    />
                </div>

                {/* Event log */}
                {showEventLog && (
                    <div className="mb-3">
                        <EventLogPanel entries={eventLog} onClear={() => setEventLog([])} />
                    </div>
                )}
            </div>
        </div>
    );
}
