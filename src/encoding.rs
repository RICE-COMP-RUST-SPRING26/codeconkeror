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
//   metadata:   JSON object (simplest is {}, decoding should go until a full json object is found)
//   patch:      remaining bytes, sequence of encoded OpComponents

use crate::patch::{OpComponent, Patch};

const TAG_RETAIN: u8 = 0x01;
const TAG_DELETE: u8 = 0x02;
const TAG_INSERT: u8 = 0x03;

impl OpComponent {
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
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        for op in &self.ops {
            op.encode(&mut buf);
        }
        buf
    }

    pub fn from_bytes(data: &[u8]) -> Result<Self, String> {
        let mut ops = Vec::new();
        let mut pos = 0;
        while pos < data.len() {
            ops.push(OpComponent::decode(data, &mut pos)?);
        }
        Ok(Patch { ops })
    }
}

// TODO: implement for PatchEntry
pub struct PatchEntry {
    patch: Patch,
    timestamp: u64,
    metadata: serde_json::Value,
}

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

fn read_u64_le(data: &[u8], pos: &mut usize) -> Result<u64, String> {
    if *pos + 8 > data.len() {
        return Err("unexpected end of data reading u64".into());
    }
    let bytes: [u8; 8] = data[*pos..*pos + 8]
        .try_into()
        .map_err(|_| "slice conversion failed")?;
    *pos += 8;
    Ok(u64::from_le_bytes(bytes))
}

fn read_u128_le(data: &[u8], pos: &mut usize) -> Result<u128, String> {
    if *pos + 16 > data.len() {
        return Err("unexpected end of data reading u128".into());
    }
    let bytes: [u8; 16] = data[*pos..*pos + 16]
        .try_into()
        .map_err(|_| "slice conversion failed")?;
    *pos += 16;
    Ok(u128::from_le_bytes(bytes))
}
