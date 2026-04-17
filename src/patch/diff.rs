use super::builder::PatchBuilder;
use super::*;

pub fn diff(before: &str, after: &str) -> Patch {
    let b = before.as_bytes();
    let a = after.as_bytes();
    let n = b.len();
    let m = a.len();

    // Build the DP table for edit distance / LCS.
    // dp[i][j] = length of LCS of b[..i] and a[..j]
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for i in 1..=n {
        for j in 1..=m {
            if b[i - 1] == a[j - 1] {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = dp[i - 1][j].max(dp[i][j - 1]);
            }
        }
    }

    // Trace back through the DP table to build the patch.
    // We walk backwards, collecting ops in reverse, then reverse at the end.
    let mut ops: Vec<OpComponent> = Vec::new();
    let mut i = n;
    let mut j = m;

    while i > 0 || j > 0 {
        if i > 0 && j > 0 && b[i - 1] == a[j - 1] {
            // Match -> Retain
            ops.push(OpComponent::Retain(1));
            i -= 1;
            j -= 1;
        } else if j > 0 && (i == 0 || dp[i][j - 1] >= dp[i - 1][j]) {
            // Character in `after` not in `before` -> Insert
            ops.push(OpComponent::Insert(String::from(a[j - 1] as char)));
            j -= 1;
        } else {
            // Character in `before` not in `after` -> Delete
            ops.push(OpComponent::Delete(1));
            i -= 1;
        }
    }

    ops.reverse();

    // Compact the ops using PatchBuilder.
    let mut builder = PatchBuilder::new();
    for op in ops {
        match op {
            OpComponent::Retain(n) => builder.retain(n),
            OpComponent::Insert(s) => builder.insert(&s),
            OpComponent::Delete(n) => builder.delete(n),
        }
    }

    builder.build()
}
