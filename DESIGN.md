# Transform strategy
```doc
Suppose that a client is at the seq_num TIME, and the user makes a patch "d"
When it reaches the server, 3 more patches have been made since SEQ:
... (TIME) a b c

The server then transforms d against these three patches in order
(ad, da) = t(a, d)
(b(da), dab) = t(b, da)
(c(dab), dabc) = t(c, dab)

Resulting in a patch dabc (d transformed against a then b then c)
In the process, we get a rebased version of the history, [ad, b(da), c(dab)]

The server appends dabc to its log, so it has
S := a b c dabc

To the client who sent "d", we send the rebased commits, which it applies after "d"
C := d ad b(da) c(dab)

d ad = a da
C = a da b(da) c(dab)

da b(da) = b da(b)
C = a b dab c(dab)

dab c(dab) = c dabc
C = a b c dabc = S

So S = C as desired, meaning that the client and server will have the same content
```

# Module src/patch/
## OpComponent
```rust
// Core operation component of a patch
enum OpComponent {
    // Keep n characters from the input
    Retain(usize),
    // Insert string at current position
    Insert(String),
    // Delete n characters from the input
    Delete(usize),
}
```

## Patch
```rust
// A patch is a sequence of operations over a document
struct Patch {
    ops: Vec<OpComponent>,
}

// Create a new patch from a list of operations
fn new(ops: Vec<OpComponent>) -> Self;

// Returns the expected input length (retain + delete)
fn input_len(&self) -> usize;

// Returns the output length after applying the patch
fn output_len(&self) -> usize;

// Applies the patch to a document string
// Returns error if operations go out of bounds or don't fully consume input
fn apply(&self, doc: &str) -> Result<String, String>;

// Computes a patch that transforms `before` into `after`
// Uses an LCS-based diff algorithm
fn diff(before: &str, after: &str) -> Self;

// Transforms two concurrent patches into (a', b')
// Ensures applying in either order yields the same result (TP1)
// Tie-break: this patch's inserts take priority
fn transform(&self, other: &Patch) -> Result<(Patch, Patch), String>;
```

# Types
```rust
pub type Version = logtree::SeqNum;
pub type Branch = logtree::BranchNum;
pub type ClientId = u128;
pub type DocumentPos = usize;
pub type DocumentId = u128;
```

# Module src/encoding.rs
Stores the time of a patch, and metadata passed by the user.
If the user omits metadata, store an empty object.
The metadata MUST be a json object, it cannot be an arbitrary json value.
```rust
pub struct PatchEntry {
    patch: Patch,
    timestamp: u64,
    metadata: serde_json::Value,
}
```

This module provides `to_bytes` and `from_bytes` functions for encoding/decoding patches onto disk

# Module src/serialize.rs
Provides functions which should be used for serializing instances of `Patch`

# Module src/logtrees.rs
Handles storing logtrees on disk.
```rust
struct LogtreeStorage {
    logtrees: HashMap<DocumentId, Arc<LogTree>>,
    directory: String,
}

// Retrieves a logtree by document ID
fn get_logtree(&mut self, doc_id) -> Result<Arc<LogTree>>;
// First checks LOGTREES
// If not found, loads from disk, storing it in LOGTREES

// Creates a new logtree
fn create_logtree(&mut self) -> Result<Arc<LogTree>>;
// Stores result in LOGTREES
```

# Module src/replay.rs
Calculate the current document content by replaying every patch in a branch.
```rust
fn calculate_document_content(tree: &LogTree, branch_num) -> Result<String>
```

# Module src/branches.rs
Handles storing branches

## Events
```rust
enum BranchEvent {
    // Some other client sent a patch
    ExternalPatch { seqnum, patch },
    // Contains OTed versions of the patches the client will need
    // to apply to get back up to date
    ConfirmPatch { seqnum, rebased: Vec<Patch> },
}

struct Broadcaster {
    // Sends a BranchEvent to the broadcast channel
    send: Box<dyn Fn(BranchEvent) -> Result<()>>,
}
```

## Branch
```rust
struct BranchState {
    snapshot: String,
    connections: Vec<Broadcaster>,
    seq_num: SeqNum,
    cached_patches: Deque<(SeqNum, Patch)>, // N most recent patches
}

struct Branch {
    tree: Arc<LogTree>,
    branch_num: BranchNum,
    state: Mutex<BranchState>,
}

Branch::new(tree: Arc<LogTree>, branch_num, seq_num, content: String)

// The node prev_seq_num should already exist in the tree: the patch was applied after it.
// If there have been patches since, apply OT to get a new version of the patch
fn Branch::patch(&mut self, prev_seq_num, patch, metadata) -> Vec<Patch>
// 1. Lock the BranchState for the remainder of the function
// 2. Ensure that state.seq_num >= prev_seq_num
// 3. Get all patches in the range (prev_seq_num, state.seq_num], either cached, or from the LogTree
// 4. Start with patch_prime=patch, then for each committed_patch in this range:
// 4.1. (committed_prime, patch_prime) = transform(committed_patch, patch_prime)
// 4.2. Collect committed_prime into a vector 'rebased'
// 5. Append a new PatchEntry with patch=patch_prime, metadata, and the current time to the tree
// 6. For each broadcaster:
// 6.1. If the client id matches, send a ConfirmPatch, and the new latest seq_num
// 6.2. Otherwise, send an ExternalPatch with patch_prime
```

## Branch manager
Manages multiple branches at once
```rust
#[derive(Send, Sync)]
struct BranchManager {
    branches: RwLock<HashMap<(DocumentId, BranchNum), Arc<Branch>>>>,
    storage: Mutex<LogtreeStorage>,
}

fn get_document_tree(&self, docid) -> Result<Arc<Logtree>>
// 1. With the storage locked, call storage.get_logtree

fn open_branch(&self, docid, branch_num) -> Result<Arc<Branch>>;
// 1. With branches read-locked: return the entry if it is already there
// 2. With storage locked: call get_logtree
// 3. Get the branch head seq_num
// 4. Call calculate_document_content on the tree to get the current branch content
// 5. With branches write-locked:
// 5.1. Check if the entry is there now, and return it if so
// 5.2. Add a new entry for this branch, calling Branch::new

fn create_document(&self, content: &str, metadata: serde_json::Value) -> Result<DocumentId>
// 1. With the storage locked, call create logtree
// 2. Add a patch to the logtree adding a new PatchEntry containing content and metadata to the default branch
// 3. With branches write-locked, add a new entry for the default branch
```

# Module src/web_api.rs
```rust
const BRANCH_MANAGER: LazyLock<BranchManager>
```

The tree has a default branch (returned by `tree.main_branch_num`), so if `branch_num` is omitted from any requests, that is the assumed branch.
```rust
// Creates a new document from initial content string
POST documents/ { content: String, metadata (optional) } -> DocumentId
// 1. Calls create_document on the branch manager

enum SSEEvent {
    // Initial document state
    Init { seqNum, content }
    BranchEvent(BranchEvent)
}

GET documents/DOCID { branch_num (optional) } -> { content, seq_num }
// 1. Call open_branch on the branch manager
// 2. With the state locked, return the content and seq num

GET documents/DOCID (mode=subscribe) { branch_num (optional), client_id }
// 1. Set up a Broadcaster which will send events over SSE, and returns Err when the connection closes
// 2. Call open_branch
// 3. With the state locked:
// 3.1. Send the Init SSE event
// 3.2. Add the broadcaster to the vec of broadcasters

PATCH documents/DOCID { branch_num (optional), client_id, prev_seq_num, patch, metadata (optional) }
// 1. Call open_branch
// 2. Call branch.patch(...)

GET document/DOCID/branches {}
-> { branches: { branchNum, headSeq (CANNOT be null), parentBranch (can be null), parentSeq (can be null) }[] }
// 1. Call BRANCH_MANAGER.get_document_tree(...)
// 2. Call list_branches on the tree
// 3. Return the adapted list, or respond with an error if any of them have a seq_num of None.
// This is because the tree datastructure allows empty trees, but the server assumes documents are nonempty

GET document/DOCID/nodes { branchNum (optional), start: SeqNum, end: SeqNum }
-> { nodes: { seq, patch, timestamp, metadata }[] }
// 1. Call BRANCH_MANAGER.get_document_tree(...)
// 2. Call tree.read_range to get the nodes
// 3. Parse each node to get the correct format, and return it
```
