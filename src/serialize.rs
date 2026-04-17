use crate::patch::{OpComponent, Patch};

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Module-style serde glue for `Patch`, usable as `#[serde(with = "crate::serialize")]`.
pub fn serialize<S: Serializer>(patch: &Patch, serializer: S) -> Result<S::Ok, S::Error> {
    serialize_patch(patch, serializer)
}

pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Patch, D::Error> {
    deserialize_patch(deserializer)
}

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

/// Serde glue for `Option<Patch>`, usable as `#[serde(with = "crate::serialize::option_patch")]`.
pub mod option_patch {
    use super::*;

    pub fn serialize<S: Serializer>(patch: &Option<Patch>, serializer: S) -> Result<S::Ok, S::Error> {
        match patch {
            Some(p) => serialize_patch(p, serializer),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Patch>, D::Error> {
        let opt = Option::<serde_json::Value>::deserialize(deserializer)?;
        match opt {
            None => Ok(None),
            Some(v) => {
                let s = v.to_string();
                let mut de = serde_json::Deserializer::from_str(&s);
                deserialize_patch(&mut de).map(Some).map_err(serde::de::Error::custom)
            }
        }
    }
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
