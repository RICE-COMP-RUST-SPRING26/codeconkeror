use super::*;

/// A helper that builds a normalized patch, merging consecutive same-type
/// components and dropping zero-length ones.
pub struct PatchBuilder {
    ops: Vec<OpComponent>,
}

impl PatchBuilder {
    /// Create an empty builder.
    pub fn new() -> Self {
        PatchBuilder { ops: Vec::new() }
    }

    /// Append a retain of `n` characters, merging with the preceding retain if any.
    pub fn retain(&mut self, n: usize) {
        if n == 0 {
            return;
        }
        if let Some(OpComponent::Retain(prev)) = self.ops.last_mut() {
            *prev += n;
        } else {
            self.ops.push(OpComponent::Retain(n));
        }
    }

    /// Append an insert of string `s`, merging with the preceding insert if any.
    pub fn insert(&mut self, s: &str) {
        if s.is_empty() {
            return;
        }
        if let Some(OpComponent::Insert(prev)) = self.ops.last_mut() {
            prev.push_str(s);
        } else {
            self.ops.push(OpComponent::Insert(s.to_string()));
        }
    }

    /// Append a delete of `n` characters, merging with the preceding delete if any.
    pub fn delete(&mut self, n: usize) {
        if n == 0 {
            return;
        }
        if let Some(OpComponent::Delete(prev)) = self.ops.last_mut() {
            *prev += n;
        } else {
            self.ops.push(OpComponent::Delete(n));
        }
    }

    /// Consume the builder and return the normalized `Patch`.
    pub fn build(self) -> Patch {
        Patch { ops: self.ops }
    }
}
