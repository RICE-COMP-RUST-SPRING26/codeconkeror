export type Op =
  | { retain: number }
  | { insert: string }
  | { delete: number };

export type Patch = { ops: Op[] };

export type BranchSummary = {
  branch_num: number;
  head_seq: number;
  parent_branch: number | null;
  parent_seq: number | null;
};

export type NodeSummary = {
  seq: number;
  patch: Patch;
  timestamp: number;
  metadata: Record<string, unknown>;
};

export type ClientStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type DispatchedPatch = {
  patch: Patch;
  documentBeforePatch: string;
  documentAfterPatch: string;
  externalPatchesSinceDispatch: Patch[];
};

export type ExternalCursor = {
  pos: number;
  metadata: Record<string, unknown>;
};

export type ClientObservableState = {
  displayedContent: string;
  cursor: number;
  lastCommittedState: { seqNum: number; content: string };
  dispatched: DispatchedPatch | null;
  rebasedDispatched: Patch | null;
  queued: Patch;
  branchNum: number;
  clientId: string;
  connStatus: ClientStatus;
  initialized: boolean;
  externalCursors: Map<string, ExternalCursor>;
};

export type EventLogEntry = {
  id: number;
  time: Date;
  direction: 'in' | 'out';
  type: string;
  detail: string;
};

export type DebugSegment = {
  text: string;
  layer: 'committed' | 'pending' | 'queued';
};
