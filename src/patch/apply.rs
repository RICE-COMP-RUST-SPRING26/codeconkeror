use super::*;

/// Apply the patch to a document
pub fn apply(patch: &Patch, doc: &str) -> Result<String, String> {
    use OpComponent::*;

    let mut result = String::new();
    let mut chars = doc.chars();
    let char_count = doc.chars().count();
    let mut pos = 0;

    for op in &patch.ops {
        match op {
            Retain(n) => {
                let n = *n;
                if pos + n > char_count {
                    return Err(format!(
                        "retain({n}) at pos {pos} exceeds doc char len {}",
                        char_count
                    ));
                }
                // Push exactly `n` characters to the result
                for _ in 0..n {
                    if let Some(c) = chars.next() {
                        result.push(c);
                    }
                }
                pos += n;
            }
            Insert(s) => {
                result.push_str(s);
            }
            Delete(n) => {
                let n = *n;
                if pos + n > char_count {
                    return Err(format!(
                        "delete({n}) at pos {pos} exceeds doc char len {}",
                        char_count
                    ));
                }
                // Advance the iterator to drop the deleted characters
                for _ in 0..n {
                    chars.next();
                }
                pos += n;
            }
        }
    }

    if pos != char_count {
        return Err(format!(
            "patch did not consume entire doc: consumed {pos}, doc char len {}",
            char_count
        ));
    }
    Ok(result)
}
