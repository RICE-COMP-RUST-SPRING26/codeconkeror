use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use once_map::OnceMap;
use serde::Serialize;

use crate::encoding::PatchEntry;
use crate::logtrees::{LogTree, LogtreeStorage};
use crate::patch::Patch;
use crate::replay;
use crate::types::{Branch as BranchNum, ClientId, DocumentId, DocumentPos, Version};

/// Maximum number of recent patches kept in the in-memory ring buffer per branch.
const CACHE_CAPACITY: usize = 512;

// ==================== Events ====================

/// An event sent over SSE to connected clients whenever branch state changes.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type")]
pub enum BranchEvent {
    /// A patch (and/or cursor update) from another client has been committed.
    #[serde(rename = "external_update")]
    ExternalUpdate {
        // Present iff a patch was committed
        #[serde(skip_serializing_if = "Option::is_none")]
        seqnum: Option<Version>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            with = "crate::serialize::option_patch"
        )]
        patch: Option<Patch>,
        client_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cursor: Option<DocumentPos>,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        cursor_removed: bool,
        metadata: serde_json::Value,
    },
    /// Confirmation sent back to the originating client after their patch is committed.
    #[serde(rename = "confirm_patch")]
    ConfirmPatch {
        seqnum: Version,
        /// OT-rebased versions of the patches committed between the client's
        /// `prev_seq_num` and the newly committed patch.  The client must apply
        /// these (in order) after its own original patch to converge with the server.
        rebased: Vec<SerializedPatch>,
    },
}

/// Wrapper that carries a `Patch` through JSON serialization.
#[derive(Serialize, Clone, Debug)]
pub struct SerializedPatch {
    #[serde(with = "crate::serialize")]
    pub patch: Patch,
}

/// Function signature for sending a [`BranchEvent`] to a subscriber.
pub type SendFn = Arc<dyn Fn(BranchEvent) -> Result<(), BroadcastError> + Send + Sync + 'static>;

/// Error returned when a broadcast send fails (the receiving channel was dropped).
#[derive(Debug)]
pub struct BroadcastError;

/// A live SSE connection to a specific client.
pub struct Broadcaster {
    pub client_id: ClientId,
    pub send: SendFn,
}

/// Cursor position snapshot returned as part of the `Init` SSE event.
pub struct CursorSnapshot {
    pub client_id: ClientId,
    pub position: DocumentPos,
    pub metadata: serde_json::Value,
}

// ==================== Branch ====================

/// The last-known cursor position for a connected client.
pub struct BranchCursor {
    pub position: DocumentPos,
    /// Metadata from the most recent patch request that moved this cursor.
    pub metadata: serde_json::Value,
}

/// Mutable runtime state for an open branch (held behind a `Mutex`).
pub struct BranchState {
    /// Current document content (result of replaying all committed patches).
    pub snapshot: String,
    /// Most recent cursor position reported by each connected client.
    pub cursors: HashMap<ClientId, BranchCursor>,
    /// All live SSE connections subscribed to this branch.
    pub connections: Vec<Broadcaster>,
    /// Sequence number of the most recently committed patch on this branch.
    pub seq_num: Version,
    /// Ring buffer of the `CACHE_CAPACITY` most recently committed patches,
    /// keyed by their sequence number.  Used to avoid disk reads during OT.
    pub cached_patches: VecDeque<(Version, Patch)>,
}

/// A single branch within a document, combining its persistent logtree handle
/// with in-memory collaborative state.
pub struct Branch {
    pub tree: Arc<LogTree>,
    pub branch_num: BranchNum,
    pub state: Mutex<BranchState>,
}

/// Returned by [`Branch::patch`] to the HTTP handler.
pub struct PatchResult {
    /// Sequence number after the patch was committed (or current head if no patch was sent).
    pub new_seq: Version,
    /// OT-rebased versions of patches committed ahead of this one, which the
    /// originating client must apply to converge.
    pub rebased: Vec<Patch>,
}

impl Branch {
    /// Create a new in-memory branch wrapping `tree` at the given `seq_num` and
    /// initial `content`.
    pub fn new(
        tree: Arc<LogTree>,
        branch_num: BranchNum,
        seq_num: Version,
        content: String,
    ) -> Arc<Self> {
        Arc::new(Self {
            tree,
            branch_num,
            state: Mutex::new(BranchState {
                snapshot: content,
                cursors: HashMap::new(),
                connections: Vec::new(),
                seq_num,
                cached_patches: VecDeque::new(),
            }),
        })
    }

    /// Register a new SSE subscriber and return the current `(seq_num, snapshot, cursors)`
    /// so the caller can emit an `Init` event before streaming further updates.
    pub fn add_connection(
        &self,
        broadcaster: Broadcaster,
    ) -> (Version, String, Vec<CursorSnapshot>) {
        let mut st = self.state.lock().unwrap();
        st.connections.push(broadcaster);
        let cursors = st
            .cursors
            .iter()
            .map(|(&client_id, c)| CursorSnapshot {
                client_id,
                position: c.position,
                metadata: c.metadata.clone(),
            })
            .collect();
        (st.seq_num, st.snapshot.clone(), cursors)
    }

    /// Apply an incoming patch (and/or cursor update) from a client.
    ///
    /// Performs OT against all patches committed since `prev_seq_num`, appends
    /// the rebased patch to the logtree, updates the in-memory snapshot, and
    /// broadcasts the appropriate events to all live connections.
    ///
    /// Returns the new sequence number and the rebased history the client needs
    /// in order to converge with the server.
    pub fn patch(
        &self,
        client_id: ClientId,
        prev_seq_num: Version,
        patch: Option<Patch>,
        cursor: Option<DocumentPos>,
        metadata: serde_json::Value,
    ) -> Result<PatchResult, String> {
        let mut st = self.state.lock().unwrap();

        if prev_seq_num > st.seq_num {
            return Err(format!(
                "prev_seq_num {prev_seq_num} is ahead of branch head {}",
                st.seq_num
            ));
        }

        // Collect committed patches in (prev_seq_num, state.seq_num]
        let committed = collect_patches(&self.tree, self.branch_num, &st, prev_seq_num)?;

        // Transform cursor through committed patches and store it.
        let rebased_cursor = cursor.map(|mut pos| {
            for p in &committed {
                pos = p.transform_cursor(pos);
            }
            pos
        });
        if let Some(pos) = rebased_cursor {
            st.cursors.insert(
                client_id,
                BranchCursor {
                    position: pos,
                    metadata: metadata.clone(),
                },
            );
        }

        // OT the incoming patch against each committed patch.
        let (patch_prime, rebased, new_seq) = if let Some(patch) = patch {
            let mut patch_prime = patch;
            let mut rebased: Vec<Patch> = Vec::with_capacity(committed.len());
            for committed_patch in committed.iter() {
                let (committed_prime, new_patch_prime) = committed_patch.transform(&patch_prime)?;
                rebased.push(committed_prime);
                patch_prime = new_patch_prime;
            }

            let new_snapshot = patch_prime.apply(&st.snapshot)?;

            let entry = PatchEntry::new(patch_prime.clone(), metadata.clone());
            let bytes = entry.to_bytes();
            self.tree
                .append_to_branch(self.branch_num, &bytes)
                .map_err(|e| format!("{e}"))?;

            st.seq_num += 1;
            let new_seq = st.seq_num;
            st.snapshot = new_snapshot;

            st.cached_patches.push_back((new_seq, patch_prime.clone()));
            while st.cached_patches.len() > CACHE_CAPACITY {
                st.cached_patches.pop_front();
            }

            (Some(patch_prime), rebased, Some(new_seq))
        } else {
            (None, Vec::new(), None)
        };

        // Send updates to all clients
        let originator_client_id = format!("{:032x}", client_id);
        let rebased_serialized: Vec<SerializedPatch> = rebased
            .iter()
            .cloned()
            .map(|p| SerializedPatch { patch: p })
            .collect();

        // Track connections that failed so we can clean up cursors afterwards.
        let mut dead_clients: Vec<ClientId> = Vec::new();

        st.connections.retain(|conn| {
            let event = if conn.client_id == client_id {
                if let Some(seq) = new_seq {
                    BranchEvent::ConfirmPatch {
                        seqnum: seq,
                        rebased: rebased_serialized.clone(),
                    }
                } else {
                    return true; // cursor-only: no need to echo back to sender
                }
            } else {
                BranchEvent::ExternalUpdate {
                    seqnum: new_seq,
                    patch: patch_prime.clone(),
                    client_id: originator_client_id.clone(),
                    cursor: rebased_cursor,
                    cursor_removed: false,
                    metadata: metadata.clone(),
                }
            };
            log::info!("broadcast to client {:032x}: {:?}", conn.client_id, event);
            let ok = (conn.send)(event).is_ok();
            if !ok {
                dead_clients.push(conn.client_id);
            }
            ok
        });

        // Clean up cursors for clients whose last connection just died.
        for dead_id in dead_clients {
            let still_connected = st.connections.iter().any(|c| c.client_id == dead_id);
            if !still_connected {
                st.cursors.remove(&dead_id);
                // Notify remaining connections that this cursor is gone.
                let dead_id_str = format!("{:032x}", dead_id);
                st.connections.retain(|conn| {
                    let event = BranchEvent::ExternalUpdate {
                        seqnum: None,
                        patch: None,
                        client_id: dead_id_str.clone(),
                        cursor: None,
                        cursor_removed: true,
                        metadata: serde_json::json!({}),
                    };
                    (conn.send)(event).is_ok()
                });
            }
        }

        Ok(PatchResult {
            new_seq: new_seq.unwrap_or(st.seq_num),
            rebased,
        })
    }
}

/// Fetch committed patches on `branch_num` in the range `(after_seq, state.seq_num]`.
///
/// Checks the in-memory ring buffer first; falls back to reading from disk if
/// the cache does not cover the full requested range.
fn collect_patches(
    tree: &LogTree,
    branch_num: BranchNum,
    state: &BranchState,
    after_seq: Version,
) -> Result<Vec<Patch>, String> {
    if after_seq >= state.seq_num {
        return Ok(Vec::new());
    }

    // Check cache first
    let need_from = after_seq + 1;
    let need_to = state.seq_num;

    if let Some((first_cached_seq, _)) = state.cached_patches.front() {
        if *first_cached_seq <= need_from {
            // Entire range is in cache
            let mut out = Vec::new();
            for (seq, patch) in state.cached_patches.iter() {
                if *seq >= need_from && *seq <= need_to {
                    out.push(patch.clone());
                }
            }
            return Ok(out);
        }
    }

    // Fall back to reading from disk
    let payloads = tree
        .read_range(branch_num, need_from, need_to)
        .map_err(|e| format!("{e}"))?;
    let mut out = Vec::with_capacity(payloads.len());
    for bytes in payloads {
        let entry = PatchEntry::from_bytes(&bytes)?;
        out.push(entry.patch);
    }
    Ok(out)
}

// ==================== BranchManager ====================

/// Coordinates access to multiple branches across multiple documents.
///
/// Thread-safe: branches are opened lazily and cached for the lifetime of the
/// process.
pub struct BranchManager {
    branches: OnceMap<(DocumentId, BranchNum), Arc<Branch>>,
    storage: Mutex<LogtreeStorage>,
}

impl BranchManager {
    /// Create a manager backed by the given storage.
    pub fn new(storage: LogtreeStorage) -> Self {
        Self {
            branches: OnceMap::new(),
            storage: Mutex::new(storage),
        }
    }

    /// Load (or return the cached) logtree for `doc_id`.
    pub fn get_document_tree(&self, doc_id: DocumentId) -> Result<Arc<LogTree>, String> {
        let mut storage = self.storage.lock().unwrap();
        storage.get_logtree(doc_id)
    }

    /// Open (or return the cached) branch for `(doc_id, branch_num)`.
    ///
    /// On first access, replays the entire branch history to build the current
    /// in-memory snapshot.
    pub fn open_branch(
        &self,
        doc_id: DocumentId,
        branch_num: BranchNum,
    ) -> Result<&Branch, String> {
        let entry = self
            .branches
            .try_insert::<String>((doc_id, branch_num), move |_| {
                let tree = self.get_document_tree(doc_id)?;
                let head_seq = tree.branch_head(branch_num).map_err(|e| format!("{e}"))?;
                let content = replay::calculate_document_content(&tree, branch_num)?;

                let branch = Branch::new(tree, branch_num, head_seq, content);
                return Ok(branch);
            })?;
        return Ok(entry);
    }

    /// Create a new document from `content`, writing an initial patch to the
    /// logtree and caching the resulting branch.
    pub fn create_document(
        &self,
        content: &str,
        metadata: serde_json::Value,
    ) -> Result<DocumentId, String> {
        let tree = {
            let mut storage = self.storage.lock().unwrap();
            storage.create_logtree()?
        };
        let doc_id = tree.get_document_id();
        let branch_num = tree.main_branch_num();

        let initial_patch = Patch::diff("", content);
        let entry = PatchEntry::new(initial_patch.clone(), metadata);
        let bytes = entry.to_bytes();
        let _seq = tree
            .append_to_branch(branch_num, &bytes)
            .map_err(|e| format!("{e}"))?;

        let branch = Branch::new(tree, branch_num, 1, content.to_string());
        self.branches.insert((doc_id, branch_num), |_| branch);
        Ok(doc_id)
    }

    /// Create a new branch forking off `parent_branch` at `parent_seq`.
    ///
    /// The new branch's first node is a retain-all patch so that replaying it
    /// from scratch yields the correct document content at the fork point.
    pub fn add_branch(
        &self,
        doc_id: DocumentId,
        parent_branch: BranchNum,
        parent_seq: Version,
        metadata: serde_json::Value,
    ) -> Result<BranchNum, String> {
        let tree = self.get_document_tree(doc_id)?;
        let new_branch_num = tree
            .add_branch(parent_branch, parent_seq)
            .map_err(|e| format!("{e}"))?;

        // Read document content at parent_seq on parent_branch, then create a
        // retain-all patch as the initial node on the new branch.
        let content = replay::read_and_apply(&tree, parent_branch, 1, parent_seq)?;
        let char_count = content.chars().count();
        let retain_patch = if char_count > 0 {
            Patch::new(vec![crate::patch::OpComponent::Retain(char_count)])
        } else {
            Patch::new(vec![])
        };
        let entry = PatchEntry::new(retain_patch, metadata);
        let bytes = entry.to_bytes();
        tree.append_to_branch(new_branch_num, &bytes)
            .map_err(|e| format!("{e}"))?;

        Ok(new_branch_num)
    }

    /// If we have a cached `BranchState`, its `seq_num` is authoritative
    /// (see ISSUES.md §1 re: logtree off-by-one). Otherwise return None so
    /// the caller falls back to the on-disk head.
    pub fn cached_head_seq(&self, doc_id: DocumentId, branch_num: BranchNum) -> Option<Version> {
        let b = self.branches.get(&(doc_id, branch_num))?;
        Some(b.state.lock().unwrap().seq_num)
    }
}
