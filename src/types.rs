//! Primitive domain type aliases used throughout the codebase.

/// Sequence number identifying a committed node within a logtree branch.
pub type Version = logtree::SeqNum;

/// Index of a branch within a document's logtree.
pub type Branch = logtree::BranchNum;

/// Opaque 128-bit identifier for a connected editing client.
pub type ClientId = u128;

/// Character-offset cursor position within a document (Unicode scalar values, 0-based).
pub type DocumentPos = u64;

/// Opaque 128-bit identifier for a document stored on disk.
pub type DocumentId = u128;
