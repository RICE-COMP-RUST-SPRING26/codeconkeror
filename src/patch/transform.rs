use super::builder::PatchBuilder;
use super::*;

/// Iterator that lets us consume components in partial chunks.
struct OpIter<'a> {
    ops: &'a [OpComponent],
    index: usize,
    offset: usize, // how far into the current component we've consumed
}

impl<'a> OpIter<'a> {
    /// Create an iterator positioned at the start of `ops`.
    fn new(ops: &'a [OpComponent]) -> Self {
        OpIter {
            ops,
            index: 0,
            offset: 0,
        }
    }

    /// Peek at the type of the current component without consuming.
    fn peek_type(&self) -> Option<ComponentType> {
        self.ops.get(self.index).map(|op| match op {
            OpComponent::Retain(_) => ComponentType::Retain,
            OpComponent::Insert(_) => ComponentType::Insert,
            OpComponent::Delete(_) => ComponentType::Delete,
        })
    }

    /// Consume up to `n` characters from a Retain or Delete, or the whole Insert.
    /// Returns the consumed component.
    fn take(&mut self, n: usize) -> Option<OpComponent> {
        let op = self.ops.get(self.index)?;
        match op {
            OpComponent::Retain(len) => {
                let remaining = len - self.offset;
                let take = n.min(remaining);
                self.offset += take;
                if self.offset == *len {
                    self.index += 1;
                    self.offset = 0;
                }
                Some(OpComponent::Retain(take))
            }
            OpComponent::Insert(s) => {
                // For inserts during transform, we always take the whole
                // remaining substring up to n chars.
                let remaining = &s[self.offset..];
                let take = n.min(remaining.len());
                let chunk = &remaining[..take];
                self.offset += take;
                if self.offset == s.len() {
                    self.index += 1;
                    self.offset = 0;
                }
                Some(OpComponent::Insert(chunk.to_string()))
            }
            OpComponent::Delete(len) => {
                let remaining = len - self.offset;
                let take = n.min(remaining);
                self.offset += take;
                if self.offset == *len {
                    self.index += 1;
                    self.offset = 0;
                }
                Some(OpComponent::Delete(take))
            }
        }
    }

    /// Take an entire insert component (convenience for transform logic).
    fn take_insert(&mut self) -> Option<String> {
        if let Some(OpComponent::Insert(s)) = self.ops.get(self.index) {
            let chunk = s[self.offset..].to_string();
            self.index += 1;
            self.offset = 0;
            Some(chunk)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ComponentType {
    Retain,
    Insert,
    Delete,
}

/// Transform two concurrent patches `a` and `b` (both applied to the same
/// original document) into `(a', b')` such that:
///
///   apply(apply(doc, a), b') == apply(apply(doc, b), a')
///
/// This satisfies TP1.
///
/// Tie-breaking: when both sides insert at the same position, `a`'s insert
/// goes first. This is arbitrary but must be consistent.
pub fn transform(a: &Patch, b: &Patch) -> Result<(Patch, Patch), String> {
    if a.input_len() != b.input_len() {
        return Err(format!(
            "patches operate on different document lengths: {} vs {}",
            a.input_len(),
            b.input_len()
        ));
    }

    let mut iter_a = OpIter::new(&a.ops);
    let mut iter_b = OpIter::new(&b.ops);
    let mut a_prime = PatchBuilder::new(); // a', to be applied after b
    let mut b_prime = PatchBuilder::new(); // b', to be applied after a

    loop {
        let type_a = iter_a.peek_type();
        let type_b = iter_b.peek_type();

        // Both sides are now Retain or Delete (consuming input chars).
        // We need to figure out how many characters to process together.
        match (type_a, type_b) {
            (None, None) => break,
            // If `a` inserts here, it goes into a' as-is, and b' must retain over it.
            // (a has priority on tie-break)
            (Some(ComponentType::Insert), _) => {
                let s = iter_a.take_insert().unwrap();
                let len = s.len();
                a_prime.insert(&s);
                b_prime.retain(len);
                continue;
            }
            // If `b` inserts here, it goes into b' as-is, and a' must retain over it.
            (_, Some(ComponentType::Insert)) => {
                let s = iter_b.take_insert().unwrap();
                let len = s.len();
                b_prime.insert(&s);
                a_prime.retain(len);
                continue;
            }
            (Some(ComponentType::Retain), Some(ComponentType::Retain)) => {
                let (chunk_a, _chunk_b) = take_min_pair(&mut iter_a, &mut iter_b);
                let n = retain_len(&chunk_a);
                // Both retain: both primes retain.
                a_prime.retain(n);
                b_prime.retain(n);
            }
            (Some(ComponentType::Delete), Some(ComponentType::Delete)) => {
                // Both delete the same region: neither prime needs anything,
                // the characters are already gone.
                take_min_pair(&mut iter_a, &mut iter_b);
            }
            (Some(ComponentType::Delete), Some(ComponentType::Retain)) => {
                let (chunk_a, _chunk_b) = take_min_pair(&mut iter_a, &mut iter_b);
                let n = delete_len(&chunk_a);
                // a deletes, b retains: a' still deletes, b' does nothing
                // (the chars were removed by a, so b' skips them).
                a_prime.delete(n);
            }
            (Some(ComponentType::Retain), Some(ComponentType::Delete)) => {
                let (_chunk_a, chunk_b) = take_min_pair(&mut iter_a, &mut iter_b);
                let n = delete_len(&chunk_b);
                // b deletes, a retains: b' still deletes, a' does nothing.
                b_prime.delete(n);
            }
            (None, Some(_)) | (Some(_), None) => {
                return Err("patches are misaligned — one side finished early".to_string());
            }
        }
    }

    Ok((a_prime.build(), b_prime.build()))
}

/// Consume the minimum overlapping chunk from both iterators.
fn take_min_pair(a: &mut OpIter, b: &mut OpIter) -> (OpComponent, OpComponent) {
    let len_a = remaining_len(a);
    let len_b = remaining_len(b);
    let n = len_a.min(len_b);
    let ca = a.take(n).unwrap();
    let cb = b.take(n).unwrap();
    (ca, cb)
}

/// Number of input characters remaining in the current (non-insert) component of `iter`.
fn remaining_len(iter: &OpIter) -> usize {
    match iter.ops.get(iter.index) {
        Some(OpComponent::Retain(n)) | Some(OpComponent::Delete(n)) => n - iter.offset,
        _ => 0,
    }
}

/// Extract the character count from a `Retain` component (0 for any other variant).
fn retain_len(op: &OpComponent) -> usize {
    match op {
        OpComponent::Retain(n) => *n,
        _ => 0,
    }
}

/// Extract the character count from a `Delete` component (0 for any other variant).
fn delete_len(op: &OpComponent) -> usize {
    match op {
        OpComponent::Delete(n) => *n,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use OpComponent::*;

    /// Apply `patch` to `doc` by walking ops directly (test helper, avoids the apply module).
    fn apply(doc: &str, patch: &Patch) -> String {
        let mut result = String::new();
        let mut pos = 0;
        for op in &patch.ops {
            match op {
                Retain(n) => {
                    result.push_str(&doc[pos..pos + n]);
                    pos += n;
                }
                Insert(s) => {
                    result.push_str(s);
                }
                Delete(n) => {
                    pos += n;
                }
            }
        }
        result
    }

    #[test]
    fn test_concurrent_inserts() {
        // doc = "abc" (len 3)
        // a inserts "X" at 1: [Retain(1), Insert("X"), Retain(2)]  -> "aXbc"
        // b inserts "Y" at 2: [Retain(2), Insert("Y"), Retain(1)]  -> "abYc"
        let doc = "abc";
        let a = Patch::new(vec![Retain(1), Insert("X".into()), Retain(2)]);
        let b = Patch::new(vec![Retain(2), Insert("Y".into()), Retain(1)]);

        let (a_prime, b_prime) = transform(&a, &b).unwrap();

        let via_a = apply(&apply(doc, &a), &b_prime);
        let via_b = apply(&apply(doc, &b), &a_prime);
        assert_eq!(via_a, via_b);
        assert_eq!(via_a, "aXbYc");
    }

    #[test]
    fn test_concurrent_deletes_same_region() {
        // doc = "abcd" (len 4)
        // a deletes "bc": [Retain(1), Delete(2), Retain(1)] -> "ad"
        // b deletes "b":  [Retain(1), Delete(1), Retain(2)] -> "acd"
        let doc = "abcd";
        let a = Patch::new(vec![Retain(1), Delete(2), Retain(1)]);
        let b = Patch::new(vec![Retain(1), Delete(1), Retain(2)]);

        let (a_prime, b_prime) = transform(&a, &b).unwrap();

        let via_a = apply(&apply(doc, &a), &b_prime);
        let via_b = apply(&apply(doc, &b), &a_prime);
        assert_eq!(via_a, via_b);
        assert_eq!(via_a, "ad");
    }

    #[test]
    fn test_insert_vs_delete() {
        // doc = "abcd" (len 4)
        // a inserts "X" at 2: [Retain(2), Insert("X"), Retain(2)] -> "abXcd"
        // b deletes "bc":     [Retain(1), Delete(2), Retain(1)]   -> "ad"
        let doc = "abcd";
        let a = Patch::new(vec![Retain(2), Insert("X".into()), Retain(2)]);
        let b = Patch::new(vec![Retain(1), Delete(2), Retain(1)]);

        let (a_prime, b_prime) = transform(&a, &b).unwrap();

        let via_a = apply(&apply(doc, &a), &b_prime);
        let via_b = apply(&apply(doc, &b), &a_prime);
        assert_eq!(via_a, via_b);
    }

    #[test]
    fn test_identity() {
        // Both patches are identity (all retain).
        let doc = "hello";
        let a = Patch::new(vec![Retain(5)]);
        let b = Patch::new(vec![Retain(5)]);

        let (a_prime, b_prime) = transform(&a, &b).unwrap();

        assert_eq!(apply(&apply(doc, &a), &b_prime), "hello");
        assert_eq!(apply(&apply(doc, &b), &a_prime), "hello");
    }

    #[test]
    fn test_mismatched_lengths() {
        let a = Patch::new(vec![Retain(5)]);
        let b = Patch::new(vec![Retain(3)]);
        assert!(transform(&a, &b).is_err());
    }
}
