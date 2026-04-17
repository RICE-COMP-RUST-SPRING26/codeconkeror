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

export type ClientObservableState = {
  displayedContent: string;
  confirmedContent: string;
  confirmedSeq: number;
  branchNum: number;
  hasPending: boolean;
  pending: Patch | null;
  queued: Patch;
  clientId: string;
  connStatus: ClientStatus;
  initialized: boolean;
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
