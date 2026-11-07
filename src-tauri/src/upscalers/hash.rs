//! MD5 helpers. The public DLL catalog and DLSS Swapper both use MD5, so the
//! launcher verifies the same value instead of inventing a second identity.

use std::io::Read;
use std::path::Path;

use md5::{Digest, Md5};

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(&mut out, "{byte:02X}");
    }
    out
}

/// Uppercase MD5 of a whole file.
pub fn md5_file(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut reader = std::io::BufReader::with_capacity(64 * 1024, file);
    let mut hasher = Md5::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(to_hex(&hasher.finalize()))
}

/// Uppercase MD5 of an in-memory payload (a downloaded archive or DLL).
pub fn md5_bytes(bytes: &[u8]) -> String {
    to_hex(&Md5::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::{md5_bytes, md5_file};

    #[test]
    fn empty_payload_matches_the_known_md5() {
        assert_eq!(md5_bytes(b""), "D41D8CD98F00B204E9800998ECF8427E");
    }

    #[test]
    fn file_hash_matches_the_byte_hash() {
        let path = std::env::temp_dir().join("efxlve-upscaler-md5-test.bin");
        std::fs::write(&path, b"efxlve").expect("write test file");
        assert_eq!(md5_file(&path).unwrap(), md5_bytes(b"efxlve"));
        let _ = std::fs::remove_file(path);
    }
}
