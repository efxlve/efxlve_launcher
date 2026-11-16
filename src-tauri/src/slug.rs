/** Lowercase ASCII slug used for archive folder names. */
pub fn slugify(title: &str) -> String {
    let mut s = String::new();
    let mut last_dash = false;
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && (c == ' ' || c == '-' || c == '_') {
            s.push('-');
            last_dash = true;
        }
    }
    let trimmed = s.trim_matches('-');
    if trimmed.is_empty() {
        "game".to_string()
    } else {
        trimmed.to_string()
    }
}
