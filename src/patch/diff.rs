use super::builder::PatchBuilder;
use super::*;

pub fn diff(before: &str, after: &str) -> Patch {
    // Collect strings into Vec<char> so we diff by whole characters
    let b: Vec<char> = before.chars().collect();
    let a: Vec<char> = after.chars().collect();
    let n = b.len();
    let m = a.len();

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

    let mut ops: Vec<OpComponent> = Vec::new();
    let mut i = n;
    let mut j = m;

    while i > 0 || j > 0 {
        if i > 0 && j > 0 && b[i - 1] == a[j - 1] {
            ops.push(OpComponent::Retain(1));
            i -= 1;
            j -= 1;
        } else if j > 0 && (i == 0 || dp[i][j - 1] >= dp[i - 1][j]) {
            // Safe to convert a valid char to a String
            ops.push(OpComponent::Insert(a[j - 1].to_string()));
            j -= 1;
        } else {
            ops.push(OpComponent::Delete(1));
            i -= 1;
        }
    }

    ops.reverse();

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
