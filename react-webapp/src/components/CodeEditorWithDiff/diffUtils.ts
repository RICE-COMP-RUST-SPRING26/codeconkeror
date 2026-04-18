export type AlignedLine = {
    text: string;
    type: "equal" | "insert" | "delete" | "spacer";
    lineNumber?: number;
};

export function getAlignedDiffs(oldCode: string, newCode: string) {
    const s1 = oldCode.split("\n");
    const s2 = newCode.split("\n");

    // 1. Build the LCS (Longest Common Subsequence) Matrix
    const n = s1.length;
    const m = s2.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));

    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            if (s1[i - 1] === s2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // 2. Backtrack to find the diff
    const leftLines: AlignedLine[] = [];
    const rightLines: AlignedLine[] = [];

    let i = n,
        j = m;
    let leftLineCount = n;
    let rightLineCount = m;

    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && s1[i - 1] === s2[j - 1]) {
            // Lines are equal
            const text = s1[i - 1];
            leftLines.unshift({ text, type: "equal", lineNumber: leftLineCount-- });
            rightLines.unshift({ text, type: "equal", lineNumber: rightLineCount-- });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            // Line was inserted in the new version
            leftLines.unshift({ text: "", type: "spacer" });
            rightLines.unshift({ text: s2[j - 1], type: "insert", lineNumber: rightLineCount-- });
            j--;
        } else {
            // Line was deleted from the old version
            leftLines.unshift({ text: s1[i - 1], type: "delete", lineNumber: leftLineCount-- });
            rightLines.unshift({ text: "", type: "spacer" });
            i--;
        }
    }

    return {
        leftContent: leftLines.map((l) => l.text).join("\n"),
        rightContent: rightLines.map((l) => l.text).join("\n"),
        leftLines,
        rightLines,
    };
}
