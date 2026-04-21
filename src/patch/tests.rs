// Test a large number of randomly generated patches to ensure that TP1 holds
#[cfg(test)]
mod fuzz_tests {
    use crate::patch::builder::PatchBuilder;

    use super::super::*;
    use rand::Rng;
    use rand::SeedableRng;
    use rand::rngs::StdRng;

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
    fn random_test_tp1() {
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

            let (a_prime, b_prime) = match a.transform(&b) {
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

    #[test]
    fn random_test_tp1_seq() {
        let seed: u64 = 12345;
        let mut rng = StdRng::seed_from_u64(seed);
        let num_iterations = 50;
        let max_doc_len = 50;
        let patch_count = 100;

        for _ in 0..num_iterations {
            let doc = random_doc(&mut rng, max_doc_len);
            let doc_len = doc.len();

            let patches = std::iter::repeat_n((), patch_count)
                .map(|()| random_patch(&mut rng, doc_len))
                .collect::<Vec<_>>();

            let mut canonical_patches: Vec<Patch> = vec![];
            let mut rebase_lists: Vec<Vec<Patch>> = vec![];

            for p in &patches {
                let mut list = vec![];
                let mut acc = p.clone();
                for canonical in &canonical_patches {
                    let (acc_prime, canonical_prime) = acc.transform(canonical).unwrap();
                    list.push(canonical_prime);
                    acc = acc_prime;
                }
                rebase_lists.push(list);
                canonical_patches.push(acc);
            }

            for (i, p) in patches.iter().enumerate() {
                // First, apply all canonical patches up to and including i
                let mut doc1 = doc.clone();
                for canonical in &canonical_patches[0..=i] {
                    doc1 = canonical.apply(&doc1).unwrap();
                }
                // Then, apply p followed by the rebased canonical patches
                let mut doc2 = p.apply(&doc).unwrap();
                assert_eq!(i, rebase_lists[i].len());
                for transformed in &rebase_lists[i] {
                    doc2 = transformed.apply(&doc2).unwrap();
                }

                assert_eq!(doc1, doc2);
            }
        }
    }
}

#[cfg(test)]
mod diff_tests {
    use super::super::*;
    use OpComponent::*;

    /// Apply a patch to a document string, panicking on error (test helper).
    fn apply(doc: &str, patch: &Patch) -> String {
        patch.apply(doc).unwrap()
    }

    #[test]
    fn test_diff_insert() {
        let patch = Patch::diff("abc", "aXbc");
        assert_eq!(patch.input_len(), 3);
        assert_eq!(apply("abc", &patch), "aXbc");
    }

    #[test]
    fn test_diff_delete() {
        let patch = Patch::diff("abcd", "ad");
        assert_eq!(patch.input_len(), 4);
        assert_eq!(apply("abcd", &patch), "ad");
    }

    #[test]
    fn test_diff_replace() {
        let patch = Patch::diff("hello", "help");
        assert_eq!(apply("hello", &patch), "help");
    }

    #[test]
    fn test_diff_identical() {
        let patch = Patch::diff("same", "same");
        assert_eq!(patch.ops, vec![Retain(4)]);
    }

    #[test]
    fn test_diff_empty_to_something() {
        let patch = Patch::diff("", "hello");
        assert_eq!(patch.input_len(), 0);
        assert_eq!(apply("", &patch), "hello");
    }

    #[test]
    fn test_diff_something_to_empty() {
        let patch = Patch::diff("hello", "");
        assert_eq!(patch.input_len(), 5);
        assert_eq!(apply("hello", &patch), "");
    }

    #[test]
    fn test_diff_complex() {
        let patch = Patch::diff("the quick brown fox", "a quick red fox jumps");
        assert_eq!(
            apply("the quick brown fox", &patch),
            "a quick red fox jumps"
        );
    }
}
