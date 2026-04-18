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
        const nl = text.indexOf("\n", i);
        if (nl === -1) {
            lines.push(text.slice(i));
            break;
        }
        lines.push(text.slice(i, nl + 1));
        i = nl + 1;
    }
    return lines;
}

function linesMatch(lineA: string, lineB: string): boolean {
    // Strip trailing \n or \r\n before comparing
    const cleanA = lineA.replace(/\r?\n$/, "");
    const cleanB = lineB.replace(/\r?\n$/, "");
    return cleanA === cleanB;
}

export function diffLines(left: string, right: string): DiffPart[] {
    const a = splitIntoLines(left);
    const b = splitIntoLines(right);
    const n = a.length;
    const m = b.length;

    // LCS via DP
    const W = m + 1;
    const dp = new Uint16Array((n + 1) * W);
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            dp[i * W + j] = linesMatch(a[i - 1], b[j - 1]) // <-- CHANGED HERE
                ? dp[(i - 1) * W + (j - 1)] + 1
                : Math.max(dp[(i - 1) * W + j], dp[i * W + (j - 1)]);
        }
    }

    // Backtrack from (n, m)
    const edits: Array<{ type: "equal" | "delete" | "insert"; value: string }> = [];
    let i = n,
        j = m;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && linesMatch(a[i - 1], b[j - 1])) {
            // <-- CHANGED HERE
            // If they match visually but one has a newline and the other doesn't,
            // default to keeping the left side's version to preserve the file structure.
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

    // --- NEW: Semantic Cleanup Pass ---
    // Dissolve trivial "equal" blocks (empty or whitespace-only lines)
    // that break up contiguous changes.
    let k = 0;
    while (k < edits.length) {
        if (edits[k].type === "equal" && edits[k].value.trim() === "") {
            let start = k;
            let end = k;

            // Find the extent of this blank/empty "equal" block
            while (
                end < edits.length &&
                edits[end].type === "equal" &&
                edits[end].value.trim() === ""
            ) {
                end++;
            }

            // If it's bordered by differences on BOTH sides, it shouldn't split the block
            const hasPrevChange = start > 0 && edits[start - 1].type !== "equal";
            const hasNextChange = end < edits.length && edits[end].type !== "equal";

            if (hasPrevChange && hasNextChange) {
                const dissolved: typeof edits = [];
                // Group the dissolved deletes first, then inserts to help them merge
                // nicely into standard diff chunks.
                for (let x = start; x < end; x++) {
                    dissolved.push({ type: "delete", value: edits[x].value });
                }
                for (let x = start; x < end; x++) {
                    dissolved.push({ type: "insert", value: edits[x].value });
                }
                edits.splice(start, end - start, ...dissolved);

                // Adjust k to skip past the newly inserted dissolved items
                k = start + dissolved.length;
                continue;
            } else {
                // If it wasn't sandwiched, just skip past this equal block
                k = end;
                continue;
            }
        }
        k++;
    }

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
    const contentLines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return oneBasedLineNum > contentLines;
}
