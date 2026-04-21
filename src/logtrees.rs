use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use logtree::{FilePagesStorage, OnDiskTree, PAGE_SIZE};

use crate::types::DocumentId;

pub type LogTree = OnDiskTree<FilePagesStorage>;

/// In-memory cache of open logtrees, backed by files in a single directory.
pub struct LogtreeStorage {
    logtrees: HashMap<DocumentId, Arc<LogTree>>,
    directory: PathBuf,
}

impl LogtreeStorage {
    /// Open (or create) the storage directory and return an empty cache.
    pub fn new<P: AsRef<Path>>(directory: P) -> std::io::Result<Self> {
        let dir = directory.as_ref().to_path_buf();
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            logtrees: HashMap::new(),
            directory: dir,
        })
    }

    /// Canonical path for the on-disk file storing document `doc_id`.
    fn file_path(&self, doc_id: DocumentId) -> PathBuf {
        self.directory.join(format!("{:032x}.db", doc_id))
    }

    /// Return the logtree for `doc_id`, loading it from disk on first access.
    pub fn get_logtree(&mut self, doc_id: DocumentId) -> Result<Arc<LogTree>, String> {
        if let Some(t) = self.logtrees.get(&doc_id) {
            return Ok(t.clone());
        }
        let path = self.file_path(doc_id);
        if !path.exists() {
            return Err(format!("document {:032x} not found", doc_id));
        }
        let storage = FilePagesStorage::open(&path, PAGE_SIZE)
            .map_err(|e| format!("failed to open {}: {e}", path.display()))?;
        let tree = LogTree::open(storage).map_err(|e| format!("failed to open tree: {e}"))?;
        if tree.get_document_id() != doc_id {
            return Err(format!(
                "document id mismatch: expected {:032x}, file stored {:032x}",
                doc_id,
                tree.get_document_id()
            ));
        }
        log::info!("loaded logtree {:032x} from disk", doc_id);
        let arc = Arc::new(tree);
        self.logtrees.insert(doc_id, arc.clone());
        Ok(arc)
    }

    /// Allocate a new document ID, create its on-disk file, and cache the tree.
    pub fn create_logtree(&mut self) -> Result<Arc<LogTree>, String> {
        let doc_id: DocumentId = rand::random();
        let path = self.file_path(doc_id);
        if path.exists() {
            return Err("generated doc id collided with an existing file".into());
        }
        let storage = FilePagesStorage::open(&path, PAGE_SIZE)
            .map_err(|e| format!("failed to open {}: {e}", path.display()))?;
        let tree = LogTree::create(storage, doc_id)
            .map_err(|e| format!("failed to create tree: {e}"))?;
        log::info!("created logtree {:032x}", doc_id);
        let arc = Arc::new(tree);
        self.logtrees.insert(doc_id, arc.clone());
        Ok(arc)
    }
}
