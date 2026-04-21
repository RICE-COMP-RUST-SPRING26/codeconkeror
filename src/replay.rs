use crate::encoding::PatchEntry;
use crate::logtrees::LogTree;
use crate::types::{Branch, Version};

/// Replay every patch on `branch_num` from the beginning to produce the current document content.
pub fn calculate_document_content(tree: &LogTree, branch_num: Branch) -> Result<String, String> {
    let head = tree.branch_head(branch_num).map_err(|e| format!("{e}"))?;
    read_and_apply(tree, branch_num, 1, head)
}

/// Apply patches `[start_seq, end_seq]` on `branch_num` in order, starting from an empty string.
pub fn read_and_apply(
    tree: &LogTree,
    branch_num: Branch,
    start_seq: Version,
    end_seq: Version,
) -> Result<String, String> {
    if end_seq < start_seq {
        return Ok(String::new());
    }
    let payloads = tree
        .read_range(branch_num, start_seq, end_seq)
        .map_err(|e| format!("{e}"))?;
    let mut doc = String::new();
    for bytes in payloads {
        let entry = PatchEntry::from_bytes(&bytes)?;
        doc = entry.patch.apply(&doc)?;
    }
    Ok(doc)
}
