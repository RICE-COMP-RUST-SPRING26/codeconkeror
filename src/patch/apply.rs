use super::*;

/// Apply the patch to a document
pub fn apply(patch: &Patch, doc: &str) -> Result<String, String> {
    use OpComponent::*;

    let mut result = String::new();
    let mut pos = 0;
    let bytes = doc.as_bytes();
    for op in &patch.ops {
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
