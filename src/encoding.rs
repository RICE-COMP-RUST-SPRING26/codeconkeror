// Binary format for tree storage
//
// OpComponent encoding:
//   Tag byte:
//     0x01 = Retain, followed by u32 LE (4 bytes)
//     0x02 = Delete, followed by u32 LE (4 bytes)
//     0x03 = Insert, followed by u32 LE length, then that many UTF-8 bytes
//
// Patch entry binary layout:
//   timestamp:  8 bytes (u64 LE, millis since epoch)
//   metadata:   JSON object (simplest is {}, decoding consumes until a full json object is found)
//   patch:      remaining bytes, sequence of encoded OpComponents

use crate::patch::{OpComponent, Patch};

const TAG_RETAIN: u8 = 0x01;
const TAG_DELETE: u8 = 0x02;
const TAG_INSERT: u8 = 0x03;

impl OpComponent {
    /// Append the binary encoding of this component to `buf`.
    fn encode(&self, buf: &mut Vec<u8>) {
        match self {
            OpComponent::Retain(n) => {
                buf.push(TAG_RETAIN);
                buf.extend_from_slice(&(*n as u32).to_le_bytes());
            }
            OpComponent::Delete(n) => {
                buf.push(TAG_DELETE);
                buf.extend_from_slice(&(*n as u32).to_le_bytes());
            }
            OpComponent::Insert(s) => {
                buf.push(TAG_INSERT);
                buf.extend_from_slice(&(s.len() as u32).to_le_bytes());
                buf.extend_from_slice(s.as_bytes());
            }
        }
    }

    /// Decode one component from `data` starting at `*pos`, advancing `*pos` past it.
    fn decode(data: &[u8], pos: &mut usize) -> Result<Self, String> {
        if *pos >= data.len() {
            return Err("unexpected end of data reading tag".into());
        }
        let tag = data[*pos];
        *pos += 1;

        match tag {
            TAG_RETAIN => {
                let n = read_u32_le(data, pos)?;
                Ok(OpComponent::Retain(n as usize))
            }
            TAG_DELETE => {
                let n = read_u32_le(data, pos)?;
                Ok(OpComponent::Delete(n as usize))
            }
            TAG_INSERT => {
                let len = read_u32_le(data, pos)? as usize;
                if *pos + len > data.len() {
                    return Err("unexpected end of data reading insert string".into());
                }
                let s = std::str::from_utf8(&data[*pos..*pos + len])
                    .map_err(|e| format!("invalid utf8 in insert: {e}"))?
                    .to_string();
                *pos += len;
                Ok(OpComponent::Insert(s))
            }
            _ => Err(format!("unknown tag byte: 0x{tag:02x}")),
        }
    }
}

impl Patch {
    /// Serialize the patch to its compact binary representation.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        for op in &self.ops {
            op.encode(&mut buf);
        }
        buf
    }

    /// Deserialize a patch from its compact binary representation.
    pub fn from_bytes(data: &[u8]) -> Result<Self, String> {
        let mut ops = Vec::new();
        let mut pos = 0;
        while pos < data.len() {
            ops.push(OpComponent::decode(data, &mut pos)?);
        }
        Ok(Patch { ops })
    }
}

/// A patch together with the wall-clock timestamp and user-supplied metadata
/// it was committed with.
#[derive(Debug, Clone)]
pub struct PatchEntry {
    pub patch: Patch,
    pub timestamp: u64,
    pub metadata: serde_json::Value,
}

impl PatchEntry {
    /// Create a new entry, stamping it with the current wall-clock time in milliseconds.
    pub fn new(patch: Patch, metadata: serde_json::Value) -> Self {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Self {
            patch,
            timestamp,
            metadata,
        }
    }

    /// Serialize the entry to bytes: `[timestamp u64 LE][metadata JSON][patch bytes]`.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&self.timestamp.to_le_bytes());

        // Always serialize metadata as a JSON object. If the caller provided a
        // non-object, we store {} instead.
        let metadata_value = if self.metadata.is_object() {
            &self.metadata
        } else {
            &serde_json::Value::Object(serde_json::Map::new())
        };
        let metadata_bytes =
            serde_json::to_vec(metadata_value).expect("serializing a json value should not fail");
        buf.extend_from_slice(&metadata_bytes);

        buf.extend_from_slice(&self.patch.to_bytes());
        buf
    }

    /// Deserialize a `PatchEntry` from the format written by [`to_bytes`].
    pub fn from_bytes(data: &[u8]) -> Result<Self, String> {
        if data.len() < 8 {
            return Err("patch entry too short for timestamp".into());
        }
        let timestamp = u64::from_le_bytes(data[0..8].try_into().unwrap());

        // Parse one JSON value starting at byte 8, then pick up where it ended.
        let tail = &data[8..];
        let mut stream =
            serde_json::Deserializer::from_slice(tail).into_iter::<serde_json::Value>();
        let metadata = match stream.next() {
            Some(Ok(v)) => v,
            Some(Err(e)) => return Err(format!("invalid metadata json: {e}")),
            None => return Err("missing metadata json".into()),
        };
        if !metadata.is_object() {
            return Err("metadata must be a json object".into());
        }
        let consumed = stream.byte_offset();

        let patch = Patch::from_bytes(&tail[consumed..])?;
        Ok(PatchEntry {
            patch,
            timestamp,
            metadata,
        })
    }
}

/// Read a little-endian `u32` from `data` at `*pos`, advancing `*pos` by 4.
fn read_u32_le(data: &[u8], pos: &mut usize) -> Result<u32, String> {
    if *pos + 4 > data.len() {
        return Err("unexpected end of data reading u32".into());
    }
    let bytes: [u8; 4] = data[*pos..*pos + 4]
        .try_into()
        .map_err(|_| "slice conversion failed")?;
    *pos += 4;
    Ok(u32::from_le_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::patch::OpComponent::*;

    #[test]
    fn roundtrip_patch_entry() {
        let patch = Patch::new(vec![Retain(3), Insert("hi".into()), Delete(1)]);
        let meta = serde_json::json!({ "user": "alice", "n": 7 });
        let entry = PatchEntry {
            patch: patch.clone(),
            timestamp: 123456789,
            metadata: meta.clone(),
        };
        let bytes = entry.to_bytes();
        let decoded = PatchEntry::from_bytes(&bytes).unwrap();
        assert_eq!(decoded.timestamp, 123456789);
        assert_eq!(decoded.metadata, meta);
        assert_eq!(decoded.patch, patch);
    }

    #[test]
    fn empty_metadata_defaults() {
        let patch = Patch::new(vec![Retain(1)]);
        let entry = PatchEntry {
            patch: patch.clone(),
            timestamp: 1,
            metadata: serde_json::json!({}),
        };
        let bytes = entry.to_bytes();
        let decoded = PatchEntry::from_bytes(&bytes).unwrap();
        assert!(decoded.metadata.is_object());
        assert_eq!(decoded.metadata.as_object().unwrap().len(), 0);
    }
}
