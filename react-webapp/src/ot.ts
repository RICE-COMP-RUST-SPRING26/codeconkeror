// Operational transform primitives — TypeScript port of the JS reference.
//
// NOTE: The server uses UTF-8 byte offsets; JS strings are UTF-16 code units.
// Keep content ASCII so lengths agree.

import type { Patch, Op, DebugSegment } from './types';

class PatchBuilder {
  ops: Op[] = [];

  retain(n: number) {
    if (n <= 0) return;
    const last = this.ops[this.ops.length - 1];
    if (last && 'retain' in last) { last.retain += n; return; }
    this.ops.push({ retain: n });
  }

  insert(s: string) {
    if (!s) return;
    const last = this.ops[this.ops.length - 1];
    if (last && 'insert' in last) { last.insert += s; return; }
    this.ops.push({ insert: s });
  }

  delete(n: number) {
    if (n <= 0) return;
    const last = this.ops[this.ops.length - 1];
    if (last && 'delete' in last) { last.delete += n; return; }
    this.ops.push({ delete: n });
  }

  build(): Patch { return { ops: this.ops }; }
}

export function inputLen(patch: Patch): number {
  let total = 0;
  for (const op of patch.ops) {
    if ('retain' in op) total += op.retain;
    else if ('delete' in op) total += op.delete;
  }
  return total;
}

export function outputLen(patch: Patch): number {
  let total = 0;
  for (const op of patch.ops) {
    if ('retain' in op) total += op.retain;
    else if ('insert' in op) total += op.insert.length;
  }
  return total;
}

export function identityPatch(len: number): Patch {
  if (len === 0) return { ops: [] };
  return { ops: [{ retain: len }] };
}

export function isIdentity(patch: Patch): boolean {
  for (const op of patch.ops) {
    if ('insert' in op || 'delete' in op) return false;
  }
  return true;
}

export function applyPatch(patch: Patch, doc: string): string {
  let result = '';
  let pos = 0;
  for (const op of patch.ops) {
    if ('retain' in op) {
      result += doc.slice(pos, pos + op.retain);
      pos += op.retain;
    } else if ('insert' in op) {
      result += op.insert;
    } else if ('delete' in op) {
      pos += op.delete;
    }
  }
  return result;
}

export function diffPatches(before: string, after: string): Patch {
  const n = before.length;
  const m = after.length;
  const stride = m + 1;
  const dp = new Int32Array((n + 1) * stride);
  for (let i = 1; i <= n; i++) {
    const bi = before.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      if (bi === after.charCodeAt(j - 1)) {
        dp[i * stride + j] = dp[(i - 1) * stride + (j - 1)] + 1;
      } else {
        const up = dp[(i - 1) * stride + j];
        const left = dp[i * stride + (j - 1)];
        dp[i * stride + j] = up > left ? up : left;
      }
    }
  }

  const ops: Op[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && before.charCodeAt(i - 1) === after.charCodeAt(j - 1)) {
      ops.push({ retain: 1 }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i * stride + (j - 1)] >= dp[(i - 1) * stride + j])) {
      ops.push({ insert: after[j - 1] }); j--;
    } else {
      ops.push({ delete: 1 }); i--;
    }
  }
  ops.reverse();

  const b = new PatchBuilder();
  for (const op of ops) {
    if ('retain' in op) b.retain(op.retain);
    else if ('insert' in op) b.insert(op.insert);
    else if ('delete' in op) b.delete(op.delete);
  }
  return b.build();
}

class OpIter {
  ops: Op[];
  index = 0;
  offset = 0;

  constructor(ops: Op[]) { this.ops = ops; }

  peekType(): 'retain' | 'insert' | 'delete' | null {
    const op = this.ops[this.index];
    if (!op) return null;
    if ('retain' in op) return 'retain';
    if ('insert' in op) return 'insert';
    return 'delete';
  }

  remainingLen(): number {
    const op = this.ops[this.index];
    if (!op) return 0;
    if ('retain' in op) return op.retain - this.offset;
    if ('delete' in op) return op.delete - this.offset;
    return 0;
  }

  takeRetain(n: number): number {
    const op = this.ops[this.index] as { retain: number };
    const take = Math.min(n, op.retain - this.offset);
    this.offset += take;
    if (this.offset === op.retain) { this.index++; this.offset = 0; }
    return take;
  }

  takeDelete(n: number): number {
    const op = this.ops[this.index] as { delete: number };
    const take = Math.min(n, op.delete - this.offset);
    this.offset += take;
    if (this.offset === op.delete) { this.index++; this.offset = 0; }
    return take;
  }

  takeInsert(): string {
    const op = this.ops[this.index] as { insert: string };
    const chunk = op.insert.slice(this.offset);
    this.index++; this.offset = 0;
    return chunk;
  }
}

export function transformPatches(a: Patch, b: Patch): [Patch, Patch] {
  const iterA = new OpIter(a.ops);
  const iterB = new OpIter(b.ops);
  const aPrime = new PatchBuilder();
  const bPrime = new PatchBuilder();

  while (true) {
    const typeA = iterA.peekType();
    const typeB = iterB.peekType();
    if (typeA === null && typeB === null) break;

    if (typeA === 'insert') {
      const s = iterA.takeInsert();
      aPrime.insert(s); bPrime.retain(s.length);
      continue;
    }
    if (typeB === 'insert') {
      const s = iterB.takeInsert();
      bPrime.insert(s); aPrime.retain(s.length);
      continue;
    }

    const n = Math.min(iterA.remainingLen(), iterB.remainingLen());
    if (n === 0) throw new Error('patches misaligned');

    if (typeA === 'retain' && typeB === 'retain') {
      iterA.takeRetain(n); iterB.takeRetain(n);
      aPrime.retain(n); bPrime.retain(n);
    } else if (typeA === 'delete' && typeB === 'delete') {
      iterA.takeDelete(n); iterB.takeDelete(n);
    } else if (typeA === 'delete' && typeB === 'retain') {
      iterA.takeDelete(n); iterB.takeRetain(n);
      aPrime.delete(n);
    } else if (typeA === 'retain' && typeB === 'delete') {
      iterA.takeRetain(n); iterB.takeDelete(n);
      bPrime.delete(n);
    }
  }

  return [aPrime.build(), bPrime.build()];
}

export function summarizePatch(patch: Patch): string {
  const parts: string[] = [];
  for (const op of patch.ops) {
    if ('retain' in op) parts.push(`ret ${op.retain}`);
    else if ('insert' in op) {
      const s = op.insert.length > 24 ? op.insert.slice(0, 24) + '…' : op.insert;
      parts.push(`ins "${s.replace(/\n/g, '\\n')}"`);
    } else if ('delete' in op) parts.push(`del ${op.delete}`);
  }
  return parts.join(' / ') || '(identity)';
}

// Produce colored segments for the debug overlay.
// Returns segments of text labeled by which OT layer added them.
export function buildDebugSegments(
  confirmedContent: string,
  pending: Patch | null,
  queued: Patch,
): DebugSegment[] {
  type LayeredChar = { char: string; layer: 'committed' | 'pending' | 'queued' };

  // Apply pending, tracking char origin.
  let intermediate: LayeredChar[] = [];
  let pos = 0;

  if (!pending) {
    intermediate = confirmedContent.split('').map(c => ({ char: c, layer: 'committed' as const }));
  } else {
    for (const op of pending.ops) {
      if ('retain' in op) {
        for (let k = 0; k < op.retain; k++)
          intermediate.push({ char: confirmedContent[pos++], layer: 'committed' });
      } else if ('insert' in op) {
        for (const c of op.insert)
          intermediate.push({ char: c, layer: 'pending' });
      } else if ('delete' in op) {
        pos += op.delete;
      }
    }
  }

  // Apply queued on top.
  const final: LayeredChar[] = [];
  pos = 0;
  for (const op of queued.ops) {
    if ('retain' in op) {
      for (let k = 0; k < op.retain; k++) final.push(intermediate[pos++]);
    } else if ('insert' in op) {
      for (const c of op.insert)
        final.push({ char: c, layer: 'queued' });
    } else if ('delete' in op) {
      pos += op.delete;
    }
  }

  // Collapse consecutive same-layer chars.
  const segments: DebugSegment[] = [];
  for (const { char, layer } of final) {
    if (segments.length > 0 && segments[segments.length - 1].layer === layer) {
      segments[segments.length - 1].text += char;
    } else {
      segments.push({ text: char, layer });
    }
  }
  return segments;
}

// Produce diff segments to display base vs target (for shadow diff).
export type DiffSegment = { text: string; type: 'same' | 'added' | 'removed' };

export function buildDiffSegments(base: string, target: string): DiffSegment[] {
  const baseLines = base.split('\n');
  const targetLines = target.split('\n');
  const n = baseLines.length;
  const m = targetLines.length;
  const stride = m + 1;
  const dp = new Int32Array((n + 1) * stride);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (baseLines[i - 1] === targetLines[j - 1]) {
        dp[i * stride + j] = dp[(i - 1) * stride + (j - 1)] + 1;
      } else {
        const up = dp[(i - 1) * stride + j];
        const left = dp[i * stride + (j - 1)];
        dp[i * stride + j] = up > left ? up : left;
      }
    }
  }

  type LineOp = { type: 'same' | 'added' | 'removed'; line: string };
  const lineOps: LineOp[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && baseLines[i - 1] === targetLines[j - 1]) {
      lineOps.push({ type: 'same', line: baseLines[i - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i * stride + (j - 1)] >= dp[(i - 1) * stride + j])) {
      lineOps.push({ type: 'added', line: targetLines[j - 1] }); j--;
    } else {
      lineOps.push({ type: 'removed', line: baseLines[i - 1] }); i--;
    }
  }
  lineOps.reverse();

  const segments: DiffSegment[] = [];
  for (let k = 0; k < lineOps.length; k++) {
    const { type, line } = lineOps[k];
    const text = k < lineOps.length - 1 ? line + '\n' : line;
    if (segments.length > 0 && segments[segments.length - 1].type === type) {
      segments[segments.length - 1].text += text;
    } else {
      segments.push({ text, type });
    }
  }
  return segments;
}
