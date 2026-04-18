use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_stream::StreamExt;

use crate::branches::{BranchEvent, BranchManager, BroadcastError, Broadcaster, SerializedPatch};
use crate::types::DocumentPos;
use crate::encoding::PatchEntry;
use crate::patch::Patch;
use crate::types::{Branch as BranchNum, ClientId, DocumentId, Version};

pub type AppState = Arc<BranchManager>;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/documents", post(create_document))
        .route("/documents/{doc_id}", get(get_document).patch(patch_document))
        .route("/documents/{doc_id}/branches", get(list_branches).post(create_branch))
        .route("/documents/{doc_id}/nodes", get(list_nodes))
    // Support the `document/` (no s) spellings from the design spec too.
        .route("/document/{doc_id}/branches", get(list_branches).post(create_branch))
        .route("/document/{doc_id}/nodes", get(list_nodes))
        .with_state(state)
}

// ---------------- Helpers ----------------

#[derive(Debug)]
struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = serde_json::json!({ "error": self.1 });
        (self.0, Json(body)).into_response()
    }
}

impl From<String> for ApiError {
    fn from(msg: String) -> Self {
        ApiError(StatusCode::BAD_REQUEST, msg)
    }
}

fn parse_doc_id(s: &str) -> Result<DocumentId, ApiError> {
    u128::from_str_radix(s, 16).map_err(|e| {
        ApiError(
            StatusCode::BAD_REQUEST,
            format!("invalid doc_id (expected 32-char hex): {e}"),
        )
    })
}

fn parse_client_id(s: &str) -> Result<ClientId, String> {
    u128::from_str_radix(s, 16).map_err(|e| format!("invalid client_id: {e}"))
}

// ---------------- POST /documents ----------------

#[derive(Deserialize)]
struct CreateDocRequest {
    content: String,
    #[serde(default)]
    metadata: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct CreateDocResponse {
    doc_id: String,
}

async fn create_document(
    State(state): State<AppState>,
    Json(req): Json<CreateDocRequest>,
) -> Result<Json<CreateDocResponse>, ApiError> {
    let metadata = req.metadata.unwrap_or(serde_json::json!({}));
    if !metadata.is_object() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "metadata must be a JSON object".into(),
        ));
    }
    let doc_id = state.create_document(&req.content, metadata)?;
    log::info!("created document {:032x}", doc_id);
    Ok(Json(CreateDocResponse {
        doc_id: format!("{:032x}", doc_id),
    }))
}

// ---------------- GET /documents/:doc_id ----------------

#[derive(Deserialize)]
struct DocQuery {
    #[serde(default)]
    branch_num: Option<BranchNum>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
}

#[derive(Serialize)]
struct GetDocResponse {
    content: String,
    seq_num: Version,
    branch_num: BranchNum,
}

async fn get_document(
    State(state): State<AppState>,
    Path(doc_id_str): Path<String>,
    Query(q): Query<DocQuery>,
) -> Result<Response, ApiError> {
    let doc_id = parse_doc_id(&doc_id_str)?;

    if q.mode.as_deref() == Some("subscribe") {
        return subscribe(state, doc_id, q).await;
    }

    let branch_num = q.branch_num.unwrap_or(0);
    let branch = state.open_branch(doc_id, branch_num)?;
    let st = branch.state.lock().unwrap();
    Ok(Json(GetDocResponse {
        content: st.snapshot.clone(),
        seq_num: st.seq_num,
        branch_num,
    })
       .into_response())
}

// ---------------- SSE subscribe ----------------

#[derive(Serialize)]
#[serde(tag = "event")]
enum SseEvent {
    #[serde(rename = "init")]
    Init {
        seq_num: Version,
        content: String,
        branch_num: BranchNum,
    },
    #[serde(rename = "branch")]
    Branch(BranchEvent),
}

async fn subscribe(
    state: AppState,
    doc_id: DocumentId,
    q: DocQuery,
) -> Result<Response, ApiError> {
    let branch_num = q.branch_num.unwrap_or(0);
    let client_id_str = q.client_id.ok_or_else(|| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "client_id is required for subscribe".into(),
        )
    })?;
    let client_id = parse_client_id(&client_id_str).map_err(ApiError::from)?;

    let branch = state.open_branch(doc_id, branch_num)?;

    let (tx, rx) = mpsc::unbounded_channel::<BranchEvent>();

    // Build the broadcaster
    let broadcaster = Broadcaster {
        client_id,
        send: Arc::new(move |event: BranchEvent| -> Result<(), BroadcastError> {
            tx.send(event).map_err(|_| BroadcastError)
        }),
    };

    // Register and grab initial state atomically
    log::info!("subscribe doc {:032x} branch {} client {:032x}", doc_id, branch_num, client_id);
    let (init_seq, init_content) = branch.add_connection(broadcaster);

    // Build SSE stream: first yield an Init event, then pipe BranchEvents.
    let init_evt = SseEvent::Init {
        seq_num: init_seq,
        content: init_content,
        branch_num,
    };
    let init_stream = futures::stream::once(async move {
        to_sse_event(&init_evt)
    });

    let branch_stream =
        UnboundedReceiverStream::new(rx).map(|e| to_sse_event(&SseEvent::Branch(e)));

    let combined = init_stream.chain(branch_stream);

    let mut response = Sse::new(combined)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response();

    let headers = response.headers_mut();
    headers.insert("Cache-Control", "no-cache, no-store".parse().unwrap());
    headers.insert("X-Accel-Buffering", "no".parse().unwrap());
    headers.insert("Access-Control-Allow-Origin","*".parse().unwrap());

    Ok(response)
}

fn to_sse_event(evt: &SseEvent) -> Result<Event, Infallible> {
    let json = serde_json::to_string(evt).unwrap_or_else(|_| "{}".to_string());
    Ok(Event::default().data(json))
}

// ---------------- PATCH /documents/:doc_id ----------------

#[derive(Deserialize)]
struct PatchRequest {
    #[serde(default)]
    branch_num: Option<BranchNum>,
    client_id: String,
    prev_seq_num: Version,
    #[serde(default, with = "crate::serialize::option_patch")]
    patch: Option<Patch>,
    #[serde(default)]
    cursor: Option<DocumentPos>,
    #[serde(default)]
    metadata: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct PatchResponse {
    seq_num: Version,
    rebased: Vec<SerializedPatch>,
}

async fn patch_document(
    State(state): State<AppState>,
    Path(doc_id_str): Path<String>,
    Json(req): Json<PatchRequest>,
) -> Result<Json<PatchResponse>, ApiError> {
    let doc_id = parse_doc_id(&doc_id_str)?;
    let branch_num = req.branch_num.unwrap_or(0);
    let client_id = parse_client_id(&req.client_id).map_err(ApiError::from)?;
    let metadata = req.metadata.unwrap_or(serde_json::json!({}));
    if !metadata.is_object() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "metadata must be a JSON object".into(),
        ));
    }

    let branch = state.open_branch(doc_id, branch_num)?;
    log::info!(
        "patch doc {:032x} branch {} client {:032x} prev_seq {}",
        doc_id, branch_num, client_id, req.prev_seq_num
    );
    let result = branch
        .patch(client_id, req.prev_seq_num, req.patch, req.cursor, metadata)
        .map_err(ApiError::from)?;

    let rebased = result
        .rebased
        .into_iter()
        .map(|p| SerializedPatch { patch: p })
        .collect();

    Ok(Json(PatchResponse {
        seq_num: result.new_seq,
        rebased,
    }))
}

// ---------------- GET /documents/:doc_id/branches ----------------

#[derive(Serialize)]
struct BranchesResponse {
    branches: Vec<BranchSummary>,
}

#[derive(Serialize)]
struct BranchSummary {
    branch_num: BranchNum,
    head_seq: Version,
    parent_branch: Option<BranchNum>,
    parent_seq: Option<Version>,
}

async fn list_branches(
    State(state): State<AppState>,
    Path(doc_id_str): Path<String>,
) -> Result<Json<BranchesResponse>, ApiError> {
    let doc_id = parse_doc_id(&doc_id_str)?;
    let tree = state.get_document_tree(doc_id)?;
    let infos = tree.list_branches();

    let mut branches = Vec::with_capacity(infos.len());
    for (i, info) in infos.iter().enumerate() {
        let branch_num = i as BranchNum;
        let disk_head = info.head_seq_num.ok_or_else(|| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("branch {branch_num} has no head seq"),
            )
        })?;
        let head = state
            .cached_head_seq(doc_id, branch_num)
            .unwrap_or(disk_head);
        let (parent_branch, parent_seq) = match info.parent {
            // The root branch uses (0, 0) as parent sentinel; report as None.
            Some((pb, ps)) if !(branch_num == 0 && pb == 0 && ps == 0) => (Some(pb), Some(ps)),
            _ => (None, None),
        };
        branches.push(BranchSummary {
            branch_num,
            head_seq: head,
            parent_branch,
            parent_seq,
        });
    }
    Ok(Json(BranchesResponse { branches }))
}

// ---------------- POST /documents/:doc_id/branches (extension) ----------------

#[derive(Deserialize)]
struct CreateBranchRequest {
    #[serde(default)]
    parent_branch: Option<BranchNum>,
    parent_seq: Version,
    #[serde(default)]
    metadata: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct CreateBranchResponse {
    branch_num: BranchNum,
    seq: Version,
}

async fn create_branch(
    State(state): State<AppState>,
    Path(doc_id_str): Path<String>,
    Json(req): Json<CreateBranchRequest>,
) -> Result<Json<CreateBranchResponse>, ApiError> {
    let doc_id = parse_doc_id(&doc_id_str)?;
    let parent_branch = req.parent_branch.unwrap_or(0);
    let metadata = req.metadata.unwrap_or(serde_json::json!({}));
    let branch_num = state.add_branch(doc_id, parent_branch, req.parent_seq, metadata)?;
    Ok(Json(CreateBranchResponse { branch_num, seq: req.parent_seq + 1 }))
}

// ---------------- GET /documents/:doc_id/nodes ----------------

#[derive(Deserialize)]
struct NodesQuery {
    #[serde(default)]
    branch_num: Option<BranchNum>,
    start: Version,
    end: Version,
}

#[derive(Serialize)]
struct NodesResponse {
    nodes: Vec<NodeSummary>,
}

#[derive(Serialize)]
struct NodeSummary {
    seq: Version,
    #[serde(with = "crate::serialize")]
    patch: Patch,
    timestamp: u64,
    metadata: serde_json::Value,
}

async fn list_nodes(
    State(state): State<AppState>,
    Path(doc_id_str): Path<String>,
    Query(q): Query<NodesQuery>,
) -> Result<Json<NodesResponse>, ApiError> {
    let doc_id = parse_doc_id(&doc_id_str)?;
    let branch_num = q.branch_num.unwrap_or(0);
    let tree = state.get_document_tree(doc_id)?;

    if q.end < q.start {
        return Ok(Json(NodesResponse { nodes: vec![] }));
    }

    let payloads = tree
        .read_range(branch_num, q.start, q.end)
        .map_err(|e| ApiError::from(format!("{e}")))?;

    let mut nodes = Vec::with_capacity(payloads.len());
    for (i, bytes) in payloads.into_iter().enumerate() {
        let entry = PatchEntry::from_bytes(&bytes).map_err(ApiError::from)?;
        nodes.push(NodeSummary {
            seq: q.start + i as Version,
            patch: entry.patch,
            timestamp: entry.timestamp,
            metadata: entry.metadata,
        });
    }
    Ok(Json(NodesResponse { nodes }))
}
