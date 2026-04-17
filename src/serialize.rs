use crate::patch::{OpComponent, Patch};

use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub fn serialize_patch<S: Serializer>(patch: &Patch, serializer: S) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeMap;

    struct OpComponentRef<'a>(&'a OpComponent);

    impl<'a> Serialize for OpComponentRef<'a> {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            let mut map = serializer.serialize_map(Some(1))?;
            match self.0 {
                OpComponent::Retain(n) => map.serialize_entry("retain", n)?,
                OpComponent::Delete(n) => map.serialize_entry("delete", n)?,
                OpComponent::Insert(s) => map.serialize_entry("insert", s)?,
            }
            map.end()
        }
    }

    #[derive(Serialize)]
    struct Wrapper<'a> {
        ops: Vec<OpComponentRef<'a>>,
    }

    let wrapper = Wrapper {
        ops: patch.ops.iter().map(OpComponentRef).collect(),
    };
    wrapper.serialize(serializer)
}

pub fn deserialize_patch<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Patch, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum RawOp {
        Retain { retain: usize },
        Delete { delete: usize },
        Insert { insert: String },
    }

    #[derive(Deserialize)]
    struct RawPatch {
        ops: Vec<RawOp>,
    }

    let raw = RawPatch::deserialize(deserializer)?;
    let ops = raw
        .ops
        .into_iter()
        .map(|op| match op {
            RawOp::Retain { retain } => OpComponent::Retain(retain),
            RawOp::Delete { delete } => OpComponent::Delete(delete),
            RawOp::Insert { insert } => OpComponent::Insert(insert),
        })
        .collect();

    Ok(Patch { ops })
}
