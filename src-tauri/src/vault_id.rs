//! Folder names that are safe to join under an account vault.
//!
//! `Path::join` replaces the base when the child is absolute, and `..` walks
//! out of the vault. Both would let an IPC `account_id` reach `remove_dir_all`
//! outside the account directory.

/// Store account ids are hex, decimal or (Amazon) dotted identifiers.
/// Anything that could walk out of the vault is rejected.
pub fn is_vault_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.contains("..")
        && !id.starts_with('.')
        && !id.ends_with(".json")
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_store_account_ids() {
        assert!(is_vault_id("19927295d6e3467887d4e830d8c85963"));
        assert!(is_vault_id("46899977096215655"));
        assert!(is_vault_id("test_acc_1"));
        assert!(is_vault_id("gog-user"));
        // Amazon user ids carry dots.
        assert!(is_vault_id("amzn1.account.AFKX5XATOLRQFJ43UI4FYQXORTNQ"));
    }

    #[test]
    fn rejects_path_escape() {
        assert!(!is_vault_id(""));
        assert!(!is_vault_id(".."));
        assert!(!is_vault_id("../secret"));
        assert!(!is_vault_id(r"..\secret"));
        assert!(!is_vault_id(r"C:\Windows"));
        assert!(!is_vault_id("/etc/passwd"));
        assert!(!is_vault_id("a/b"));
        assert!(!is_vault_id("a b"));
        assert!(!is_vault_id("id.json"));
        assert!(!is_vault_id(".hidden"));
        assert!(!is_vault_id("a..b"));
    }
}
