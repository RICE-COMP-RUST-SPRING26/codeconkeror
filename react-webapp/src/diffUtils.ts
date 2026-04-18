export type LineType = 'equal' | 'insert' | 'delete' | 'filler';

export interface AlignedLine {
  content: string;
  type: LineType;
}

export interface AlignedDiff {
  mainLines: AlignedLine[];   // left pane: equal + delete + filler where shadow inserts
  shadowLines: AlignedLine[]; // right pane: equal + insert + filler where main deletes
}

export interface LineDecoration {
  lineIndex: number; // 0-based
  className: string;
}

export interface BlockSpacer {
  afterLine: number; // 0-based; -1 = before first line
  height: number;    // pixels
}

export const DIFF_LINE_HEIGHT = 20;

function lcsMatrix(a: string[], b: string[]): Uint16Array[] {
  const m = a.length, n = b.length;
  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

export function computeAlignedDiff(main: string, shadow: string): AlignedDiff {
  const mainSplit = main.split('\n');
  const shadowSplit = shadow.split('\n');
  const dp = lcsMatrix(mainSplit, shadowSplit);

  type RawOp = { type: 'equal' | 'insert' | 'delete'; line: string };
  const ops: RawOp[] = [];
  let i = mainSplit.length, j = shadowSplit.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && mainSplit[i - 1] === shadowSplit[j - 1]) {
      ops.push({ type: 'equal', line: mainSplit[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'insert', line: shadowSplit[j - 1] });
      j--;
    } else {
      ops.push({ type: 'delete', line: mainSplit[i - 1] });
      i--;
    }
  }
  ops.reverse();

  const mainLines: AlignedLine[] = [];
  const shadowLines: AlignedLine[] = [];
  let idx = 0;

  while (idx < ops.length) {
    if (ops[idx].type === 'equal') {
      mainLines.push({ content: ops[idx].line, type: 'equal' });
      shadowLines.push({ content: ops[idx].line, type: 'equal' });
      idx++;
    } else {
      const deletes: string[] = [];
      const inserts: string[] = [];
      while (idx < ops.length && ops[idx].type !== 'equal') {
        if (ops[idx].type === 'delete') deletes.push(ops[idx].line);
        else inserts.push(ops[idx].line);
        idx++;
      }
      const maxLen = Math.max(deletes.length, inserts.length);
      for (let k = 0; k < maxLen; k++) {
        mainLines.push(k < deletes.length
          ? { content: deletes[k], type: 'delete' }
          : { content: '', type: 'filler' });
        shadowLines.push(k < inserts.length
          ? { content: inserts[k], type: 'insert' }
          : { content: '', type: 'filler' });
      }
    }
  }

  return { mainLines, shadowLines };
}

export function getMainPaneDecorations(mainLines: AlignedLine[]): {
  lineDecorations: LineDecoration[];
  blockSpacers: BlockSpacer[];
} {
  const lineDecorations: LineDecoration[] = [];
  const blockSpacers: BlockSpacer[] = [];
  let origIdx = -1;
  let fillerCount = 0;
  let lastOrigLine = -1;

  for (const line of mainLines) {
    if (line.type === 'filler') {
      fillerCount++;
    } else {
      origIdx++;
      if (fillerCount > 0) {
        blockSpacers.push({ afterLine: lastOrigLine, height: fillerCount * DIFF_LINE_HEIGHT });
        fillerCount = 0;
      }
      lastOrigLine = origIdx;
      if (line.type === 'delete') {
        lineDecorations.push({ lineIndex: origIdx, className: 'diff-line-delete' });
      }
    }
  }
  if (fillerCount > 0) {
    blockSpacers.push({ afterLine: lastOrigLine, height: fillerCount * DIFF_LINE_HEIGHT });
  }

  return { lineDecorations, blockSpacers };
}

export function getShadowPaneInfo(shadowLines: AlignedLine[]): {
  content: string;
  lineDecorations: LineDecoration[];
} {
  const content = shadowLines.map(l => l.content).join('\n');
  const lineDecorations: LineDecoration[] = [];
  for (let i = 0; i < shadowLines.length; i++) {
    const type = shadowLines[i].type;
    if (type === 'insert') lineDecorations.push({ lineIndex: i, className: 'diff-line-insert' });
    else if (type === 'filler') lineDecorations.push({ lineIndex: i, className: 'diff-line-filler' });
  }
  return { content, lineDecorations };
}
