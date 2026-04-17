import {
  applyPatch,
  diffPatches,
  transformPatches,
  identityPatch,
  isIdentity,
  outputLen,
} from './ot';
import type { Patch, ClientObservableState, EventLogEntry, BranchSummary, NodeSummary } from './types';

function patchSummary(patch: Patch): string {
  return patch.ops
    .filter(op => !('retain' in op))
    .map(op => {
      if ('insert' in op) return `+"${op.insert.length > 20 ? op.insert.slice(0, 20) + '…' : op.insert}"`;
      if ('delete' in op) return `-${op.delete}`;
      return '';
    })
    .join(' ') || '(no change)';
}

function genHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function newClientId(): string { return genHex(16); }

type DocumentClientOptions = {
  serverUrl: string;
  docId: string;
  branchNum?: number;
  clientId?: string;
  onState?: (state: ClientObservableState) => void;
  onEvent?: (entry: Omit<EventLogEntry, 'id' | 'time'>) => void;
};

export class DocumentClient {
  readonly serverUrl: string;
  readonly docId: string;
  branchNum: number;
  readonly clientId: string;
  private onStateCb: (s: ClientObservableState) => void;
  private onEventCb: (e: Omit<EventLogEntry, 'id' | 'time'>) => void;

  confirmedContent = '';
  confirmedSeq = 0;
  pending: Patch | null = null;
  queued: Patch = identityPatch(0);
  displayedContent = '';
  initialized = false;
  connStatus: ClientObservableState['connStatus'] = 'disconnected';

  sendDelay = 0; // ms; 0 = immediate
  private _sendTimer: ReturnType<typeof setTimeout> | null = null;

  private eventSource: EventSource | null = null;
  private _tail: Promise<void> = Promise.resolve();

  constructor(opts: DocumentClientOptions) {
    this.serverUrl = opts.serverUrl.replace(/\/+$/, '');
    this.docId = opts.docId;
    this.branchNum = opts.branchNum ?? 0;
    this.clientId = opts.clientId ?? genHex(16);
    this.onStateCb = opts.onState ?? (() => {});
    this.onEventCb = opts.onEvent ?? (() => {});
  }

  private _enqueue(fn: () => void | Promise<void>) {
    const run = this._tail.then(() => fn()).catch(e => {
      console.error('state transition:', e);
    });
    this._tail = run;
    return run;
  }

  private _computeDisplayed(): string {
    const withPending = this.pending
      ? applyPatch(this.pending, this.confirmedContent)
      : this.confirmedContent;
    return applyPatch(this.queued, withPending);
  }

  private _notify() {
    this.displayedContent = this._computeDisplayed();
    this.onStateCb({
      displayedContent: this.displayedContent,
      confirmedContent: this.confirmedContent,
      confirmedSeq: this.confirmedSeq,
      branchNum: this.branchNum,
      hasPending: !!this.pending,
      pending: this.pending,
      queued: this.queued,
      clientId: this.clientId,
      connStatus: this.connStatus,
      initialized: this.initialized,
    });
  }

  connect() {
    this.disconnect();
    const url = `${this.serverUrl}/documents/${this.docId}?mode=subscribe&client_id=${this.clientId}&branch_num=${this.branchNum}`;
    const es = new EventSource(url);
    this.eventSource = es;
    this.connStatus = 'connecting';
    this._notify();

    es.onopen = () => { this.connStatus = 'connected'; this._notify(); };

    es.onmessage = (ev) => {
      let data: unknown;
      try { data = JSON.parse(ev.data); } catch { return; }
      this._enqueue(() => this._handleEvent(data as Record<string, unknown>));
    };

    let reconnectedOnce = false;
    es.onerror = () => {
      this.connStatus = 'error';
      this._notify();
      if (!reconnectedOnce) {
        reconnectedOnce = true;
        es.close();
        setTimeout(() => { if (this.eventSource === es) this.connect(); }, 1500);
      }
    };
  }

  disconnect() {
    if (this.eventSource) { this.eventSource.close(); this.eventSource = null; }
    if (this._sendTimer !== null) { clearTimeout(this._sendTimer); this._sendTimer = null; }
    this.connStatus = 'disconnected';
  }

  private _handleEvent(data: Record<string, unknown>) {
    if (data.event === 'init') {
      const content = data.content as string;
      const seqNum = data.seq_num as number;
      const branchNum = data.branch_num as number;
      this.confirmedContent = content;
      this.confirmedSeq = seqNum;
      this.branchNum = branchNum;
      this.pending = null;
      this.queued = identityPatch(content.length);
      this.initialized = true;
      this.onEventCb({ direction: 'in', type: 'init', detail: `seq=${seqNum} branch=${branchNum}` });
      this._notify();
      return;
    }

    const type = data.type as string | undefined;

    if (data.event === 'branch' && type === 'external_patch') {
      const patch = data.patch as Patch;
      const seqnum = data.seqnum as number;
      this.onEventCb({ direction: 'in', type: 'external', detail: `seq=${seqnum} ${patchSummary(patch)}` });
      this._applyExternal(patch, seqnum);
      this._notify();
      this._maybePromoteAndSend();
      return;
    }

    if (data.event === 'branch' && type === 'confirm_patch') {
      const seqnum = data.seqnum as number;
      const rebased = (data.rebased as Array<{ patch: Patch }> | undefined) ?? [];
      this.onEventCb({ direction: 'in', type: 'confirm', detail: `seq=${seqnum}` });
      this._applyConfirm(seqnum, rebased);
      this._notify();
      this._maybePromoteAndSend();
      return;
    }
  }

  private _applyExternal(patch: Patch, seqnum: number) {
    if (this.pending) {
      const [pendingPrime, externalForOurSide] = transformPatches(this.pending, patch);
      this.confirmedContent = applyPatch(patch, this.confirmedContent);
      const [, queuedPrime] = transformPatches(externalForOurSide, this.queued);
      this.pending = pendingPrime;
      this.queued = queuedPrime;
    } else {
      this.confirmedContent = applyPatch(patch, this.confirmedContent);
      const [, queuedPrime] = transformPatches(patch, this.queued);
      this.queued = queuedPrime;
    }
    this.confirmedSeq = seqnum;
  }

  private _applyConfirm(seqnum: number, rebased: Array<{ patch: Patch }>) {
    if (this.pending) {
      this.confirmedContent = applyPatch(this.pending, this.confirmedContent);
    }
    for (const { patch: r } of rebased) {
      this.confirmedContent = applyPatch(r, this.confirmedContent);
      const [, queuedPrime] = transformPatches(r, this.queued);
      this.queued = queuedPrime;
    }
    this.confirmedSeq = seqnum;
    this.pending = null;
  }

  private _maybePromoteAndSend() {
    if (this.pending || isIdentity(this.queued)) return;
    if (this.sendDelay > 0) {
      if (this._sendTimer !== null) return; // already scheduled
      this._sendTimer = setTimeout(() => {
        this._sendTimer = null;
        this._enqueue(() => {
          if (this.pending || isIdentity(this.queued)) return;
          this.pending = this.queued;
          this.queued = identityPatch(outputLen(this.pending));
          this._notify();
          void this._sendPending();
        });
      }, this.sendDelay);
    } else {
      this.pending = this.queued;
      this.queued = identityPatch(outputLen(this.pending));
      void this._sendPending();
    }
  }

  private async _sendPending() {
    if (!this.pending) return;
    const body = {
      client_id: this.clientId,
      prev_seq_num: this.confirmedSeq,
      patch: this.pending,
      branch_num: this.branchNum,
    };
    this.onEventCb({ direction: 'out', type: 'patch', detail: `seq=${this.confirmedSeq} ${patchSummary(this.pending)}` });
    try {
      const res = await fetch(`${this.serverUrl}/documents/${this.docId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) console.error('PATCH failed', res.status, await res.text());
    } catch (e) {
      console.error('PATCH error', e);
    }
  }

  userEdit(newText: string) {
    return this._enqueue(() => {
      const oldDisplayed = this._computeDisplayed();
      if (newText === oldDisplayed) return;

      const confirmedWithPending = this.pending
        ? applyPatch(this.pending, this.confirmedContent)
        : this.confirmedContent;
      this.queued = diffPatches(confirmedWithPending, newText);

      if (!this.pending) this._maybePromoteAndSend();
      this._notify();
    });
  }

  async listBranches(): Promise<{ branches: BranchSummary[] }> {
    const res = await fetch(`${this.serverUrl}/documents/${this.docId}/branches`);
    if (!res.ok) throw new Error(`branches ${res.status}`);
    return res.json();
  }

  async createBranch(parentSeq: number, parentBranch: number | null = null): Promise<{ branch_num: number }> {
    const body: Record<string, unknown> = { parent_seq: parentSeq };
    if (parentBranch != null) body.parent_branch = parentBranch;
    const res = await fetch(`${this.serverUrl}/documents/${this.docId}/branches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`createBranch ${res.status}`);
    return res.json();
  }

  async fetchNodes(start: number, end: number, branchNum = this.branchNum): Promise<{ nodes: NodeSummary[] }> {
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
  const res = await fetch(`${serverUrl.replace(/\/+$/, '')}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create ${res.status} ${await res.text()}`);
  return res.json();
}
