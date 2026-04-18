import {
    applyPatch,
    diffPatches,
    transformPatches,
    identityPatch,
    isIdentity,
    outputLen,
} from "./ot";
import type {
    Patch,
    ClientObservableState,
    EventLogEntry,
    BranchSummary,
    NodeSummary,
    DispatchedPatch,
    ExternalCursor,
} from "./types";

function genHex(bytes: number): string {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return Array.from(buf)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

export function newClientId(): string {
    return genHex(16);
}

function patchSummary(patch: Patch): string {
    return (
        patch.ops
            .filter((op) => !("retain" in op))
            .map((op) => {
                if ("insert" in op)
                    return `+"${op.insert.length > 20 ? op.insert.slice(0, 20) + "…" : op.insert}"`;
                if ("delete" in op) return `-${op.delete}`;
                return "";
            })
            .join(" ") || "(no change)"
    );
}

function transformCursorByPatch(cursor: number, patch: Patch): number {
    let inputPos = 0;
    let outputPos = 0;
    for (const op of patch.ops) {
        if ("retain" in op) {
            if (cursor <= inputPos + op.retain) {
                return outputPos + (cursor - inputPos);
            }
            inputPos += op.retain;
            outputPos += op.retain;
        } else if ("insert" in op) {
            outputPos += op.insert.length;
        } else if ("delete" in op) {
            if (cursor < inputPos + op.delete) {
                return outputPos;
            }
            inputPos += op.delete;
        }
    }
    return outputPos + Math.max(0, cursor - inputPos);
}

type DocumentManagerOptions = {
    serverUrl: string;
    docId: string;
    branchNum?: number;
    clientId?: string;
    name?: string;
    onState?: (state: ClientObservableState) => void;
    onEvent?: (entry: Omit<EventLogEntry, "id" | "time">) => void;
};

export class ClientDocumentManager {
    readonly serverUrl: string;
    readonly docId: string;
    branchNum: number;
    readonly clientId: string;
    name: string;

    private onStateCb: (s: ClientObservableState) => void;
    private onEventCb: (e: Omit<EventLogEntry, "id" | "time">) => void;

    lastCommittedState = { seqNum: 0, content: "" };
    dispatched: DispatchedPatch | null = null;
    private _rebasedDispatched: Patch | null = null;
    queued: Patch = identityPatch(0);
    displayedContent = "";
    cursor = 0;
    initialized = false;
    connStatus: ClientObservableState["connStatus"] = "disconnected";
    externalCursors = new Map<string, ExternalCursor>();

    sendDelay = 0;
    private _sendTimer: ReturnType<typeof setTimeout> | null = null;
    private _cursorSendTimer: ReturnType<typeof setTimeout> | null = null;

    private eventSource: EventSource | null = null;
    private _tail: Promise<void> = Promise.resolve();

    constructor(opts: DocumentManagerOptions) {
        this.serverUrl = opts.serverUrl.replace(/\/+$/, "");
        this.docId = opts.docId;
        this.branchNum = opts.branchNum ?? 0;
        this.clientId = opts.clientId ?? genHex(16);
        this.name = opts.name ?? "";
        this.onStateCb = opts.onState ?? (() => {});
        this.onEventCb = opts.onEvent ?? (() => {});
    }

    private _enqueue(fn: () => void | Promise<void>) {
        const run = this._tail
            .then(() => fn())
            .catch((e) => {
                console.error("state transition:", e);
            });
        this._tail = run;
        return run;
    }

    private _computeDisplayed(): string {
        const base = this._rebasedDispatched
            ? applyPatch(this._rebasedDispatched, this.lastCommittedState.content)
            : this.lastCommittedState.content;
        return applyPatch(this.queued, base);
    }

    private _notify() {
        this.displayedContent = this._computeDisplayed();
        this.onStateCb({
            displayedContent: this.displayedContent,
            cursor: this.cursor,
            lastCommittedState: this.lastCommittedState,
            dispatched: this.dispatched,
            rebasedDispatched: this._rebasedDispatched,
            queued: this.queued,
            branchNum: this.branchNum,
            clientId: this.clientId,
            connStatus: this.connStatus,
            initialized: this.initialized,
            externalCursors: new Map(this.externalCursors),
        });
    }

    connect() {
        this.disconnect();
        const url = `${this.serverUrl}/documents/${this.docId}?mode=subscribe&client_id=${this.clientId}&branch_num=${this.branchNum}`;
        const es = new EventSource(url);
        this.eventSource = es;
        this.connStatus = "connecting";
        this._notify();

        es.onopen = () => {
            this.connStatus = "connected";
            this._notify();
        };

        es.onmessage = (ev) => {
            let data: unknown;
            try {
                data = JSON.parse(ev.data);
            } catch {
                return;
            }
            this._enqueue(() => this._handleEvent(data as Record<string, unknown>));
        };

        let reconnectedOnce = false;
        es.onerror = () => {
            this.connStatus = "error";
            this._notify();
            if (!reconnectedOnce) {
                reconnectedOnce = true;
                es.close();
                setTimeout(() => {
                    if (this.eventSource === es) this.connect();
                }, 1500);
            }
        };
    }

    disconnect() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
        if (this._sendTimer !== null) {
            clearTimeout(this._sendTimer);
            this._sendTimer = null;
        }
        if (this._cursorSendTimer !== null) {
            clearTimeout(this._cursorSendTimer);
            this._cursorSendTimer = null;
        }
        this.connStatus = "disconnected";
    }

    private _handleEvent(data: Record<string, unknown>) {
        if (data.event === "init") {
            const content = data.content as string;
            const seqNum = data.seq_num as number;
            const branchNum = data.branch_num as number;
            this.lastCommittedState = { seqNum, content };
            this.branchNum = branchNum;
            this.dispatched = null;
            this._rebasedDispatched = null;
            this.queued = identityPatch(content.length);
            this.initialized = true;
            this.onEventCb({
                direction: "in",
                type: "init",
                detail: `seq=${seqNum} branch=${branchNum}`,
            });
            this._notify();
            return;
        }

        const type = data.type as string | undefined;

        if (data.event === "branch" && type === "external_update") {
            const patch = data.patch as Patch | undefined;
            const cursorPos = data.cursor as number | undefined;
            const cursorRemoved = data.cursor_removed as boolean | undefined;
            const clientId = data.client_id as string | undefined;
            const metadata = (data.metadata ?? {}) as Record<string, unknown>;
            const seqnum = data.seqnum as number | undefined;

            if (patch && seqnum !== undefined) {
                this.onEventCb({
                    direction: "in",
                    type: "external",
                    detail: `seq=${seqnum} ${patchSummary(patch)}`,
                });
                this._applyExternal(patch, seqnum);
            } else if (seqnum !== undefined) {
                this.lastCommittedState = { ...this.lastCommittedState, seqNum: seqnum };
            }

            if (clientId !== undefined) {
                if (cursorRemoved) {
                    this.onExternalCursorUpdate(clientId, metadata, null);
                } else if (cursorPos !== undefined) {
                    this.onExternalCursorUpdate(clientId, metadata, cursorPos);
                }
            }

            this._notify();
            if (patch) this._maybePromoteAndSend();
            return;
        }

        if (data.event === "branch" && type === "confirm_patch") {
            const seqnum = data.seqnum as number;
            this.onEventCb({ direction: "in", type: "confirm", detail: `seq=${seqnum}` });
            this._applyConfirm(seqnum);
            this._notify();
            this._maybePromoteAndSend();
            return;
        }
    }

    private _applyExternal(patch: Patch, seqnum: number) {
        if (this.dispatched && this._rebasedDispatched) {
            const [newRebasedD, extAfterDispatched] = transformPatches(
                this._rebasedDispatched,
                patch,
            );
            const [, queuedPrime] = transformPatches(extAfterDispatched, this.queued);
            this._rebasedDispatched = newRebasedD;
            this.queued = queuedPrime;
            this.dispatched.externalPatchesSinceDispatch.push(patch);
        } else {
            const [, queuedPrime] = transformPatches(patch, this.queued);
            this.queued = queuedPrime;
        }
        this.cursor = transformCursorByPatch(this.cursor, patch);
        this.lastCommittedState = {
            seqNum: seqnum,
            content: applyPatch(patch, this.lastCommittedState.content),
        };
    }

    onPatchFailed() {
        return this._enqueue(() => {
            // 1. If dispatched is null, do nothing (no patch was in flight)
            if (!this.dispatched) return; // 2. Drop the failed patch completely

            this.dispatched = null;
            this._rebasedDispatched = null; // 3. Drop any pending unsent changes (queued) by resetting it to

            // an identity patch matching the length of the last committed content
            this.queued = identityPatch(this.lastCommittedState.content.length); // 4. Safety check: ensure the cursor doesn't end up out of bounds

            // since the document length likely just shrank
            if (this.cursor > this.lastCommittedState.content.length) {
                this.cursor = this.lastCommittedState.content.length;
            } // 5. Notify the UI to re-render the reverted state

            this._notify();
        });
    }

    private _applyConfirm(seqnum: number) {
        if (this._rebasedDispatched) {
            this.lastCommittedState = {
                seqNum: seqnum,
                content: applyPatch(this._rebasedDispatched, this.lastCommittedState.content),
            };
        } else {
            this.lastCommittedState = { ...this.lastCommittedState, seqNum: seqnum };
        }
        this.dispatched = null;
        this._rebasedDispatched = null;
    }

    onExternalCursorUpdate(
        clientId: string,
        metadata: Record<string, unknown>,
        pos: number | null,
    ) {
        if (pos === null) {
            this.externalCursors.delete(clientId);
        } else {
            this.externalCursors.set(clientId, { pos, metadata });
        }
    }

    private _maybePromoteAndSend() {
        if (this.dispatched || isIdentity(this.queued)) return;
        if (this.sendDelay > 0) {
            if (this._sendTimer !== null) return;
            this._sendTimer = setTimeout(() => {
                this._sendTimer = null;
                this._enqueue(() => {
                    if (this.dispatched || isIdentity(this.queued)) return;
                    this._promoteAndSend();
                });
            }, this.sendDelay);
        } else {
            this._promoteAndSend();
        }
    }

    private _promoteAndSend() {
        const patch = this.queued;
        this.dispatched = {
            patch,
            documentBeforePatch: this.lastCommittedState.content,
            documentAfterPatch: applyPatch(patch, this.lastCommittedState.content),
            externalPatchesSinceDispatch: [],
        };
        this._rebasedDispatched = patch;
        this.queued = identityPatch(outputLen(patch));
        this._notify();
        void this._sendPatch(patch, this.cursor);
    }

    private async _sendPatch(patch: Patch, cursor: number) {
        const metadata: Record<string, unknown> = {};
        if (this.name) metadata.name = this.name;

        const body: Record<string, unknown> = {
            client_id: this.clientId,
            prev_seq_num: this.lastCommittedState.seqNum,
            patch,
            cursor,
            branch_num: this.branchNum,
            metadata,
        };
        this.onEventCb({
            direction: "out",
            type: "patch",
            detail: `seq=${this.lastCommittedState.seqNum} ${patchSummary(patch)}`,
        });
        try {
            const res = await fetch(`${this.serverUrl}/documents/${this.docId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
        } catch (e) {
            console.error("PATCH error", e);
            this.onPatchFailed(); // Trigger on network error
            this.onEventCb({
                direction: "in",
                type: "patchError",
                detail: `${e}`,
            });
        }
    }

    private async _sendCursorOnly(cursor: number) {
        const metadata: Record<string, unknown> = {};
        if (this.name) metadata.name = this.name;

        const body: Record<string, unknown> = {
            client_id: this.clientId,
            prev_seq_num: this.lastCommittedState.seqNum,
            cursor,
            branch_num: this.branchNum,
            metadata,
        };
        try {
            await fetch(`${this.serverUrl}/documents/${this.docId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
        } catch {
            // cursor-only updates are best-effort
        }
    }

    // Called when the user edits content in the editor
    setCurrentState(content: string, cursor: number) {
        return this._enqueue(() => {
            const oldDisplayed = this._computeDisplayed();
            this.cursor = cursor;

            if (content !== oldDisplayed) {
                const base = this._rebasedDispatched
                    ? applyPatch(this._rebasedDispatched, this.lastCommittedState.content)
                    : this.lastCommittedState.content;
                this.queued = diffPatches(base, content);
                if (!this.dispatched) this._maybePromoteAndSend();
            }

            this._notify();
        });
    }

    // Called when the cursor moves without a content change
    setCursor(cursor: number) {
        return this._enqueue(() => {
            this.cursor = cursor;
            if (this._cursorSendTimer !== null) clearTimeout(this._cursorSendTimer);
            this._cursorSendTimer = setTimeout(() => {
                this._cursorSendTimer = null;
                if (!this.dispatched) void this._sendCursorOnly(this.cursor);
            }, 500);
        });
    }

    async listBranches(): Promise<{ branches: BranchSummary[] }> {
        const res = await fetch(`${this.serverUrl}/documents/${this.docId}/branches`);
        if (!res.ok) throw new Error(`branches ${res.status}`);
        return res.json();
    }

    async createBranch(
        parentSeq: number,
        parentBranch: number | null = null,
    ): Promise<{ branch_num: number }> {
        const body: Record<string, unknown> = { parent_seq: parentSeq };
        if (parentBranch != null) body.parent_branch = parentBranch;
        const res = await fetch(`${this.serverUrl}/documents/${this.docId}/branches`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`createBranch ${res.status}`);
        return res.json();
    }

    async fetchNodes(
        start: number,
        end: number,
        branchNum = this.branchNum,
    ): Promise<{ nodes: NodeSummary[] }> {
        const url = `${this.serverUrl}/documents/${this.docId}/nodes?start=${start}&end=${end}&branch_num=${branchNum}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`nodes ${res.status}`);
        return res.json();
    }
}

export async function createDocument(
    serverUrl: string,
    content: string,
    metadata?: Record<string, unknown>,
): Promise<{ doc_id: string }> {
    const body: Record<string, unknown> = { content };
    if (metadata) body.metadata = metadata;
    const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`create ${res.status} ${await res.text()}`);
    return res.json();
}
