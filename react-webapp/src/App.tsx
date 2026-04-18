import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ClientDocumentManager, createDocument, newClientId } from "./DocumentManager";
import type { ClientObservableState, BranchSummary, NodeSummary, EventLogEntry } from "./types";

import BranchControls from "./components/BranchControls";
import StatusBar from "./components/StatusBar";
import DebugPanel from "./components/DebugPanel";
import HistoryPanel from "./components/HistoryPanel";
import HistoryTreeDriver from "./components/HistoryTree/HistoryTreeDriver";
import EventLogPanel from "./components/EventLogPanel";
import { CodeEditorWithDiff } from "./components/CodeEditorWithDiff/CodeEditorWithDiff";
import type { Cursor } from "./components/CodeEditorWithDiff/CodeEditorWithDiff";
import Logo from "./assets/Logo2.png";

const SERVER_URL = "http://bore.pub:21213";
const LS_CLIENT = "branchedit.clientId";
const LS_NAME = "branchedit.name";
const LS_SEND_DELAY = "branchedit.sendDelay";

const LOREM_IPSUM =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor " +
    "incididunt ut labore et dolore magna aliqua.\n" +
    "Ut enim ad minim veniam, quis nostrud " +
    "exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.\n";

type RightPanel = "debug" | "eventlog" | "history" | "tree" | null;

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
    const [shadowBranchNum, setShadowBranchNum] = useState<number | null>(null);

    let [rightPanel, setRightPanel] = useState<RightPanel>(null);
    const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
    const logCounter = useRef(0);

    const [historyNodes, setHistoryNodes] = useState<NodeSummary[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);

    const [sendDelay, setSendDelay] = useState(() => {
        const stored = localStorage.getItem(LS_SEND_DELAY);
        return stored !== null ? Number(stored) : 250;
    });
    const sendDelayRef = useRef(sendDelay);
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

            const manager = new ClientDocumentManager({
                serverUrl: SERVER_URL,
                docId: id,
                branchNum: branch,
                clientId,
                name,
                onState: setMainState,
                onEvent: addEvent,
            });
            manager.sendDelay = sendDelayRef.current;
            managerRef.current = manager;
            manager.connect();
            setDocId(id);
        },
        [clientId, name, addEvent],
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

    useEffect(() => {
        localStorage.setItem(LS_NAME, name);
        if (managerRef.current) managerRef.current.name = name;
        if (shadowManagerRef.current) shadowManagerRef.current.name = name;
    }, [name]);

    useEffect(() => {
        sendDelayRef.current = sendDelay;
        localStorage.setItem(LS_SEND_DELAY, String(sendDelay));
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

    const handleHistoryPanel = async () => {
        if (rightPanel === "history") {
            setRightPanel(null);
            return;
        }
        const manager = managerRef.current;
        if (!manager || !mainState) return;
        setHistoryLoading(true);
        try {
            const end = mainState.lastCommittedState.seqNum;
            if (end >= 1) {
                const data = await manager.fetchNodes(1, end, mainState.branchNum);
                setHistoryNodes(data.nodes.map((n) => ({ ...n, branch_num: mainState.branchNum })));
            } else {
                setHistoryNodes([]);
            }
            setRightPanel("history");
        } catch (e) {
            alert("Failed to load history: " + (e as Error).message);
        } finally {
            setHistoryLoading(false);
        }
    };

    const forkFromNode = async (node: NodeSummary) => {
        const manager = managerRef.current;
        if (!manager || !docId || !mainState) return;
        try {
            const res = await manager.createBranch(node.seq, node.branch_num);
            await refreshBranches();
            openDocument(docId, res.branch_num);
        } catch (e) {
            alert("Fork failed: " + (e as Error).message);
        }
    };

    const startShadowing = (n: number) => {
        if (!docId) return;
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

    const togglePanel = (panel: RightPanel) => {
        stopShadowing();
        setRightPanel((prev) => (prev === panel ? null : panel));
    };

    let rightComponent: React.ReactNode = null;
    if (rightPanel === "debug" && mainState) {
        rightComponent = <DebugPanel state={mainState} />;
    } else if (rightPanel === "eventlog") {
        rightComponent = <EventLogPanel entries={eventLog} onClear={() => setEventLog([])} />;
    } else if (rightPanel === "history") {
        rightComponent = (
            <HistoryPanel
                nodes={historyNodes}
                branches={branches}
                currentBranchNum={currentBranchNum}
                loading={historyLoading}
                visible={true}
                onToggle={() => setRightPanel(null)}
                onForkHere={(node) => void forkFromNode(node)}
                onSwitchBranch={(n) => {
                    if (docId) openDocument(docId, n);
                }}
            />
        );
    } else if (rightPanel === "tree") {
        rightComponent = (
            <HistoryTreeDriver
                manager={managerRef.current}
                currentBranchNum={currentBranchNum}
                currentSeqNum={mainState?.lastCommittedState.seqNum ?? 0}
                branches={branches}
                onForkHere={(node) => void forkFromNode(node)}
            />
        );
    }

    const panelBtn = (
        panel: RightPanel,
        label: string,
        extraProps?: React.ButtonHTMLAttributes<HTMLButtonElement>,
    ) => (
        <button
            onClick={() => togglePanel(panel)}
            className={`px-3 py-1 rounded text-sm border ${
                rightPanel === panel
                    ? "bg-blue-100 border-blue-300 text-blue-700"
                    : "bg-gray-100 hover:bg-gray-200 border-gray-300"
            }`}
            {...extraProps}
        >
            {label}
        </button>
    );

    rightComponent = diffProp ? null : rightComponent;
    rightPanel = diffProp ? null : rightPanel;
    return (
        <div className="w-screen h-screen flex flex-col overflow-hidden">
            <header className="flex-shrink-0 bg-white px-4 py-2 flex flex-col gap-1.5">
                {/* Row 1: Logo centered */}
                <div className="flex justify-center">
                    <img src={Logo} className="h-8 flex-shrink-0" />
                </div>

                {/* Row 2: doc id + open + new  |  name + patch delay */}
                <div className="flex items-center gap-2 text-sm">
                    <input
                        type="text"
                        value={docIdInput}
                        onChange={(e) => setDocIdInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleOpen()}
                        placeholder="Doc id (32 hex chars)"
                        className="border border-gray-300 rounded px-2 py-1 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 w-72"
                    />
                    <button
                        onClick={handleOpen}
                        className="px-3 py-1 bg-blue-500 hover:bg-blue-600 text-white rounded text-sm"
                    >
                        Open
                    </button>
                    <button
                        onClick={() => void handleNew()}
                        className="px-3 py-1 bg-green-500 hover:bg-green-600 text-white rounded text-sm"
                    >
                        New
                    </button>
                    <div className="ml-auto flex items-center gap-3">
                        <div className="flex items-center gap-1.5">
                            <label className="text-gray-600 flex-shrink-0">Your name:</label>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Anonymous"
                                className="w-36 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                            />
                        </div>
                        <div className="flex items-center gap-1">
                            <span className="text-gray-600 flex-shrink-0">Patch delay:</span>
                            <input
                                type="number"
                                min={0}
                                step={100}
                                value={sendDelay}
                                onChange={(e) => setSendDelay(Math.max(0, Number(e.target.value)))}
                                className="w-20 border border-gray-300 rounded px-1 py-0.5 text-sm"
                            />
                            <span className="text-gray-600">ms</span>
                        </div>
                        <button
                            onClick={toggleAutoInsert}
                            disabled={!mainState?.initialized}
                            className={`px-3 py-1 rounded text-sm border disabled:opacity-40 ${
                                isAutoInserting
                                    ? "bg-red-100 hover:bg-red-200 border-red-300 text-red-700"
                                    : "bg-gray-100 hover:bg-gray-200 border-gray-300"
                            }`}
                        >
                            {isAutoInserting ? "Stop auto insert" : "Auto insert"}
                        </button>
                    </div>
                </div>

                {/* Row 3: branch controls  |  panel buttons + close */}
                <div className="flex items-center gap-2 text-sm">
                    <BranchControls
                        branches={branches}
                        currentBranchNum={currentBranchNum}
                        docId={docId}
                        onBranchChange={handleBranchChange}
                        onRefresh={() => void refreshBranches()}
                        onFork={() => void handleFork()}
                    />
                    <div className="ml-auto flex items-center gap-2">
                        {panelBtn("debug", "Debug")}
                        {panelBtn("eventlog", "Event Log")}
                        <button
                            onClick={() => void handleHistoryPanel()}
                            disabled={historyLoading}
                            className={`px-3 py-1 rounded text-sm border disabled:opacity-40 ${
                                rightPanel === "history"
                                    ? "bg-blue-100 border-blue-300 text-blue-700"
                                    : "bg-gray-100 hover:bg-gray-200 border-gray-300"
                            }`}
                        >
                            {historyLoading ? "Loading…" : "History"}
                        </button>
                        <button
                            onClick={() => {
                                togglePanel("tree");
                                void refreshBranches();
                            }}
                            disabled={!docId}
                            className={`px-3 py-1 rounded text-sm border disabled:opacity-40 ${
                                rightPanel === "tree"
                                    ? "bg-blue-100 border-blue-300 text-blue-700"
                                    : "bg-gray-100 hover:bg-gray-200 border-gray-300"
                            }`}
                        >
                            Tree
                        </button>
                        <select
                            value={shadowBranchNum !== null ? String(shadowBranchNum) : ""}
                            onChange={(e) => {
                                if (e.target.value === "") stopShadowing();
                                else startShadowing(Number(e.target.value));
                            }}
                            disabled={!docId}
                            className={`px-3 py-1 rounded text-sm border disabled:opacity-40 ${
                                shadowBranchNum !== null
                                    ? "bg-blue-100 border-blue-300 text-blue-700"
                                    : "bg-gray-100 hover:bg-gray-200 border-gray-300"
                            }`}
                        >
                            <option value="">Compare</option>
                            {branches
                                .filter((b) => b.branch_num !== currentBranchNum)
                                .map((b) => (
                                    <option key={b.branch_num} value={String(b.branch_num)}>
                                        #{b.branch_num} · head {b.head_seq}
                                    </option>
                                ))}
                        </select>
                        {(rightPanel !== null || shadowBranchNum !== null) && (
                            <button
                                onClick={() => {
                                    setRightPanel(null);
                                    stopShadowing();
                                }}
                                className="bg-red-100 hover:bg-red-200 border-red-300 text-red-700 px-3 py-1 rounded text-sm border"
                            >
                                Close
                            </button>
                        )}
                    </div>
                </div>
            </header>

            <div className="flex-1 flex flex-row overflow-hidden p-2">
                <div className={rightComponent ? "flex-1 w-0" : "flex-1"}>
                    <CodeEditorWithDiff
                        code={mainState?.displayedContent ?? ""}
                        cursors={toCursors(mainState)}
                        onChange={(content, cursor) =>
                            managerRef.current?.setCurrentState(
                                content,
                                cursor ?? mainState?.cursor ?? 0,
                            )
                        }
                        onCursorMove={(cursor) => managerRef.current?.setCursor(cursor ?? 0)}
                        diff={diffProp}
                    />
                </div>
                {rightComponent && <div className="flex-1 w-0">{rightComponent}</div>}
            </div>
            <StatusBar state={mainState} />
        </div>
    );
}
