use super::*;

/// A helper that builds a normalized patch, merging consecutive same-type
/// components and dropping zero-length ones.
pub struct PatchBuilder {
    ops: Vec<OpComponent>,
}

impl PatchBuilder {
    pub fn new() -> Self {
        PatchBuilder { ops: Vec::new() }
    }

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

    pub fn build(self) -> Patch {
        Patch { ops: self.ops }
    }
}
