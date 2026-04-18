export type DiffPart = {
    count: number;
    value: string;
    added?: boolean;
    removed?: boolean;
};

function splitIntoLines(text: string): string[] {
    const lines: string[] = [];
    let i = 0;
    while (i < text.length) {
        const nl = text.indexOf('\n', i);
        if (nl === -1) {
            lines.push(text.slice(i));
            break;
        }
        lines.push(text.slice(i, nl + 1));
        i = nl + 1;
    }
    return lines;
}

export function diffLines(left: string, right: string): DiffPart[] {
    const a = splitIntoLines(left);
    const b = splitIntoLines(right);
    const n = a.length;
    const m = b.length;

    // LCS via DP (Uint16Array for performance; file line counts stay well below 65535)
    const W = m + 1;
    const dp = new Uint16Array((n + 1) * W);
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            dp[i * W + j] =
                a[i - 1] === b[j - 1]
                    ? dp[(i - 1) * W + (j - 1)] + 1
                    : Math.max(dp[(i - 1) * W + j], dp[i * W + (j - 1)]);
        }
    }

    // Backtrack from (n, m)
    const edits: Array<{ type: "equal" | "delete" | "insert"; value: string }> = [];
    let i = n,
        j = m;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
            edits.push({ type: "equal", value: a[i - 1] });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i * W + (j - 1)] >= dp[(i - 1) * W + j])) {
            edits.push({ type: "insert", value: b[j - 1] });
            j--;
        } else {
            edits.push({ type: "delete", value: a[i - 1] });
            i--;
        }
    }
    edits.reverse();

    // Merge consecutive same-type edits into DiffPart[]
    const parts: DiffPart[] = [];
    for (const edit of edits) {
        const last = parts[parts.length - 1];
        const isAdd = edit.type === "insert";
        const isRemove = edit.type === "delete";
        const isEqual = edit.type === "equal";
        if (
            last &&
            ((isAdd && last.added && !last.removed) ||
                (isRemove && last.removed && !last.added) ||
                (isEqual && !last.added && !last.removed))
        ) {
            last.count++;
            last.value += edit.value;
        } else {
            parts.push({
                count: 1,
                value: edit.value,
                ...(isAdd ? { added: true } : {}),
                ...(isRemove ? { removed: true } : {}),
            });
        }
    }
    return parts;
}

/**
 * Returns true when a 1-based line number produced by the diff loop refers to
 * a position that is past the real content lines of `text`.
 *
 * A document ending with '\n' has a "trailing empty line" in CodeMirror that
 * is purely a cursor-position artifact, not a content line.  A left-pane
 * spacer for an added-at-end block should be anchored *after* that position
 * (side=1) so the user's cursor stays above it while they type.
 */
export function isEndOfFile(text: string, oneBasedLineNum: number): boolean {
    const contentLines =
        text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return oneBasedLineNum > contentLines;
}
