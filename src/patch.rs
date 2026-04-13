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

    /// Apply the patch to a document
    fn apply(&self, doc: &str) -> Result<String, String> {
        use OpComponent::*;

        let mut result = String::new();
        let mut pos = 0;
        let bytes = doc.as_bytes();
        for op in &self.ops {
            match op {
                Retain(n) => {
                    if pos + n > bytes.len() {
                        return Err(format!(
                            "retain({n}) at pos {pos} exceeds doc len {}",
                            bytes.len()
                        ));
                    }
                    result.push_str(&doc[pos..pos + n]);
                    pos += n;
                }
                Insert(s) => {
                    result.push_str(s);
                }
                Delete(n) => {
                    if pos + n > bytes.len() {
                        return Err(format!(
                            "delete({n}) at pos {pos} exceeds doc len {}",
                            bytes.len()
                        ));
                    }
                    pos += n;
                }
            }
        }
        if pos != bytes.len() {
            return Err(format!(
                "patch did not consume entire doc: consumed {pos}, doc len {}",
                bytes.len()
            ));
        }
        Ok(result)
    }
}

/// A helper that builds a normalized patch, merging consecutive same-type
/// components and dropping zero-length ones.
struct PatchBuilder {
    ops: Vec<OpComponent>,
}

impl PatchBuilder {
    fn new() -> Self {
        PatchBuilder { ops: Vec::new() }
    }

    fn retain(&mut self, n: usize) {
        if n == 0 {
            return;
        }
        if let Some(OpComponent::Retain(prev)) = self.ops.last_mut() {
            *prev += n;
        } else {
            self.ops.push(OpComponent::Retain(n));
        }
    }

    fn insert(&mut self, s: &str) {
        if s.is_empty() {
            return;
        }
        if let Some(OpComponent::Insert(prev)) = self.ops.last_mut() {
            prev.push_str(s);
        } else {
            self.ops.push(OpComponent::Insert(s.to_string()));
        }
    }

    fn delete(&mut self, n: usize) {
        if n == 0 {
            return;
        }
        if let Some(OpComponent::Delete(prev)) = self.ops.last_mut() {
            *prev += n;
        } else {
            self.ops.push(OpComponent::Delete(n));
        }
    }

    fn build(self) -> Patch {
        Patch { ops: self.ops }
    }
}

/// Iterator that lets us consume components in partial chunks.
struct OpIter<'a> {
    ops: &'a [OpComponent],
    index: usize,
    offset: usize, // how far into the current component we've consumed
}

impl<'a> OpIter<'a> {
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

    fn is_done(&self) -> bool {
        self.index >= self.ops.len()
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

        if type_a.is_none() && type_b.is_none() {
            break;
        }

        // If `a` inserts here, it goes into a' as-is, and b' must retain over it.
        // (a has priority on tie-break)
        if type_a == Some(ComponentType::Insert) {
            let s = iter_a.take_insert().unwrap();
            let len = s.len();
            a_prime.insert(&s);
            b_prime.retain(len);
            continue;
        }

        // If `b` inserts here, it goes into b' as-is, and a' must retain over it.
        if type_b == Some(ComponentType::Insert) {
            let s = iter_b.take_insert().unwrap();
            let len = s.len();
            b_prime.insert(&s);
            a_prime.retain(len);
            continue;
        }

        // Both sides are now Retain or Delete (consuming input chars).
        // We need to figure out how many characters to process together.
        match (type_a, type_b) {
            (Some(ComponentType::Retain), Some(ComponentType::Retain)) => {
                let (chunk_a, chunk_b) = take_min_pair(&mut iter_a, &mut iter_b);
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
            _ => unreachable!(),
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

fn remaining_len(iter: &OpIter) -> usize {
    match iter.ops.get(iter.index) {
        Some(OpComponent::Retain(n)) | Some(OpComponent::Delete(n)) => n - iter.offset,
        _ => 0,
    }
}

fn retain_len(op: &OpComponent) -> usize {
    match op {
        OpComponent::Retain(n) => *n,
        _ => 0,
    }
}

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

// Test a large number of randomly generated patches to ensure that TP1 holds
#[cfg(test)]
mod fuzz_tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::Rng;
    use rand::SeedableRng;

    /// Generate a random document of lowercase ascii chars.
    fn random_doc(rng: &mut StdRng, max_len: usize) -> String {
        let len = rng.random_range(1..=max_len);
        (0..len)
            .map(|_| (b'a' + rng.random_range(0..26)) as char)
            .collect()
    }

    /// Generate a random string to insert.
    fn random_insert_str(rng: &mut StdRng, max_len: usize) -> String {
        let len = rng.random_range(1..=max_len);
        (0..len)
            .map(|_| (b'A' + rng.random_range(0..26)) as char)
            .collect()
    }

    /// Generate a random patch for a document of the given length.
    /// Walks through the document, randomly choosing to retain, delete,
    /// or insert at each step.
    fn random_patch(rng: &mut StdRng, doc_len: usize) -> Patch {
        let mut builder = PatchBuilder::new();
        let mut remaining = doc_len;

        while remaining > 0 {
            // Randomly insert before consuming input chars
            if rng.random_range(0..4) == 0 {
                builder.insert(&random_insert_str(rng, 5));
            }

            let chunk = rng.random_range(1..=remaining);
            match rng.random_range(0..3) {
                0 => builder.retain(chunk),
                1 => builder.delete(chunk),
                _ => builder.retain(chunk), // bias toward retain so docs don't vanish
            }
            remaining -= chunk;
        }

        // Possibly insert at the end
        if rng.random_range(0..3) == 0 {
            builder.insert(&random_insert_str(rng, 5));
        }

        builder.build()
    }

    #[test]
    fn fuzz_tp1() {
        let seed: u64 = 12345;
        let mut rng = StdRng::seed_from_u64(seed);
        let num_iterations = 10_000;
        let max_doc_len = 50;

        for i in 0..num_iterations {
            let doc = random_doc(&mut rng, max_doc_len);
            let doc_len = doc.len();

            let a = random_patch(&mut rng, doc_len);
            let b = random_patch(&mut rng, doc_len);

            // Sanity: both patches must have the right input length.
            assert_eq!(
                a.input_len(),
                doc_len,
                "iteration {i}: patch a input_len mismatch"
            );
            assert_eq!(
                b.input_len(),
                doc_len,
                "iteration {i}: patch b input_len mismatch"
            );

            let (a_prime, b_prime) = match transform(&a, &b) {
                Ok(result) => result,
                Err(e) => panic!(
                    "iteration {i}: transform failed: {e}\n  doc={doc:?}\n  a={a:?}\n  b={b:?}"
                ),
            };

            // Path 1: apply a, then b'
            let after_a = a
                .apply(&doc)
                .unwrap_or_else(|e| panic!("iteration {i}: apply(doc, a) failed: {e}"));
            let path1 = b_prime.apply(&after_a)
                .unwrap_or_else(|e| panic!(
                    "iteration {i}: apply(after_a, b') failed: {e}\n  doc={doc:?}\n  a={a:?}\n  b={b:?}\n  a'={a_prime:?}\n  b'={b_prime:?}\n  after_a={after_a:?}"
                ));

            // Path 2: apply b, then a'
            let after_b = b
                .apply(&doc)
                .unwrap_or_else(|e| panic!("iteration {i}: apply(doc, b) failed: {e}"));
            let path2 = a_prime.apply(&after_b)
                .unwrap_or_else(|e| panic!(
                    "iteration {i}: apply(after_b, a') failed: {e}\n  doc={doc:?}\n  a={a:?}\n  b={b:?}\n  a'={a_prime:?}\n  b'={b_prime:?}\n  after_b={after_b:?}"
                ));

            assert_eq!(
                path1, path2,
                "iteration {i}: TP1 violated!\n  doc={doc:?}\n  a={a:?}\n  b={b:?}\n  a'={a_prime:?}\n  b'={b_prime:?}\n  path1={path1:?}\n  path2={path2:?}"
            );
        }
    }
}
