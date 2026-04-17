use crate::patch::transform::transform;

mod apply;
mod builder;
mod diff;
mod tests;
mod transform;

/// A single component of a span-based operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpComponent {
    Retain(usize),
    Insert(String),
    Delete(usize),
}

/// A patch is a sequence of components that spans the entire document.
/// Invariant: Retain + Delete counts must sum to the input document length.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Patch {
    pub ops: Vec<OpComponent>,
}

impl Patch {
    pub fn new(ops: Vec<OpComponent>) -> Self {
        Patch { ops }
    }

    /// The length this patch expects its input document to be.
    pub fn input_len(&self) -> usize {
        self.ops
            .iter()
            .map(|op| match op {
                OpComponent::Retain(n) | OpComponent::Delete(n) => *n,
                OpComponent::Insert(_) => 0,
            })
            .sum()
    }

    /// The length of the document after this patch is applied.
    pub fn output_len(&self) -> usize {
        self.ops
            .iter()
            .map(|op| match op {
                OpComponent::Retain(n) => *n,
                OpComponent::Insert(s) => s.len(),
                OpComponent::Delete(_) => 0,
            })
            .sum()
    }

    pub fn transform(&self, other: &Patch) -> Result<(Patch, Patch), String> {
        return transform(self, other);
    }

    /// Apply the patch to a document
    pub fn apply(&self, doc: &str) -> Result<String, String> {
        return apply::apply(self, doc);
    }

    /// Compute a patch that transforms `before` into `after`.
    pub fn diff(before: &str, after: &str) -> Self {
        return diff::diff(before, after);
    }

    /// Transform a cursor position through this patch.
    /// If the cursor falls inside a deleted region it is pushed to the region's start.
    pub fn transform_cursor(&self, cursor: u64) -> u64 {
        let mut input_pos: u64 = 0;
        let mut output_pos: u64 = 0;
        for op in &self.ops {
            match op {
                OpComponent::Retain(n) => {
                    let n = *n as u64;
                    if cursor < input_pos + n {
                        return output_pos + (cursor - input_pos);
                    }
                    input_pos += n;
                    output_pos += n;
                }
                OpComponent::Insert(s) => {
                    output_pos += s.len() as u64;
                }
                OpComponent::Delete(n) => {
                    let n = *n as u64;
                    if cursor < input_pos + n {
                        return output_pos;
                    }
                    input_pos += n;
                }
            }
        }
        output_pos
    }
}
