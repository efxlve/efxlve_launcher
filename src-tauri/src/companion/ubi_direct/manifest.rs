//! Ubisoft's signed install manifest.
//!
//! The CDN serves `manifests/<id>.manifest` with a 356-byte header in front of a
//! zlib stream. The inflated bytes are a `mg.protocol.download.Manifest`:
//! chunks contain files, and each file contains slices. Slices are compressed,
//! not encrypted, so the same manifest drives both the download plan and the
//! integrity checks.

use std::io::Read;

use crate::companion::proto::for_each_field;

const MANIFEST_HEADER: usize = 356;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ManifestSlice {
    pub size: u32,
    pub download_size: Option<u32>,
    pub download_sha1: Vec<u8>,
    /// SHA-1 of the decompressed bytes, from `File.slices[i]`.
    pub content_sha1: Vec<u8>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ManifestFile {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    pub slices: Vec<ManifestSlice>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Manifest {
    pub compression_method: i32,
    pub chunks_version: Option<u32>,
    pub files: Vec<ManifestFile>,
}

impl Manifest {
    pub(crate) fn total_bytes(&self) -> u64 {
        self.files.iter().map(|file| file.size).sum()
    }

    pub(crate) fn total_slices(&self) -> usize {
        self.files.iter().map(|file| file.slices.len()).sum()
    }
}

/// Decode the manifest body after the fixed CDN header has been stripped and the
/// zlib stream inflated.
pub(crate) fn parse_manifest(inflated: &[u8]) -> Manifest {
    let mut manifest = Manifest::default();
    for_each_field(
        inflated,
        |field, bytes| {
            if field == 4 {
                let files = parse_chunk(bytes);
                manifest.files.extend(files);
            }
        },
        |field, value| match field {
            7 => manifest.chunks_version = Some(value as u32),
            21 => manifest.compression_method = value as i32,
            _ => {}
        },
    );
    manifest
}

fn parse_chunk(payload: &[u8]) -> Vec<ManifestFile> {
    let mut files = Vec::new();
    for_each_field(
        payload,
        |field, bytes| {
            if field == 3 {
                if let Some(file) = parse_file(bytes) {
                    files.push(file);
                }
            }
        },
        |_, _| {},
    );
    files
}

fn parse_file(payload: &[u8]) -> Option<ManifestFile> {
    let mut file = ManifestFile::default();
    let mut content_hashes: Vec<Vec<u8>> = Vec::new();
    let mut raw_slices: Vec<ManifestSlice> = Vec::new();
    for_each_field(
        payload,
        |field, bytes| match field {
            1 => file.name = String::from_utf8_lossy(bytes).to_string(),
            4 => content_hashes.push(bytes.to_vec()),
            7 => raw_slices.push(parse_slice(bytes)),
            _ => {}
        },
        |field, value| match field {
            2 => file.size = value,
            3 => file.is_dir = value != 0,
            _ => {}
        },
    );
    if file.name.is_empty() {
        return None;
    }
    for (index, mut slice) in raw_slices.into_iter().enumerate() {
        slice.content_sha1 = content_hashes.get(index).cloned().unwrap_or_default();
        file.slices.push(slice);
    }
    Some(file)
}

fn parse_slice(payload: &[u8]) -> ManifestSlice {
    let mut slice = ManifestSlice::default();
    for_each_field(
        payload,
        |field, bytes| {
            if field == 3 {
                slice.download_sha1 = bytes.to_vec();
            }
        },
        |field, value| match field {
            1 => slice.size = value as u32,
            2 => slice.download_size = Some(value as u32),
            _ => {}
        },
    );
    slice
}

/// Fetch `url`, strip the CDN header, inflate the zlib body, and parse it.
pub(crate) async fn fetch_manifest(url: &str) -> Result<Manifest, String> {
    let bytes = reqwest::get(url)
        .await
        .map_err(|e| format!("fetching the Ubisoft manifest: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Ubisoft manifest request failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("reading the Ubisoft manifest: {e}"))?;
    if bytes.len() <= MANIFEST_HEADER {
        return Err(format!("Ubisoft manifest is only {} bytes", bytes.len()));
    }
    let mut inflated = Vec::new();
    flate2::read::ZlibDecoder::new(&bytes[MANIFEST_HEADER..])
        .read_to_end(&mut inflated)
        .map_err(|e| format!("inflating the Ubisoft manifest: {e}"))?;
    Ok(parse_manifest(&inflated))
}

/// The CDN shards slices into buckets keyed by a character derived from the
/// first byte of the uppercase-hex SHA-1, with its nibbles swapped. This is the
/// same lookup `ubisoft-demux` uses.
pub(crate) fn hash_path_char(hash_upper: &str) -> char {
    const BASE32: &[u8; 32] = b"0123456789abcdefghijklmnopqrstuv";
    let mut chars = hash_upper.chars();
    let first = chars.next().unwrap_or('0');
    let second = chars.next().unwrap_or('0');
    let swapped = format!("{second}{first}");
    let value = u8::from_str_radix(&swapped, 16).unwrap_or(0);
    let offset = (value / 16) as usize;
    let half = if value % 2 == 0 { 0 } else { 16 };
    BASE32[offset + half] as char
}

pub(crate) fn hex_upper(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02X}"));
    }
    out
}

/// Map a manifest-supplied path into `install_dir` without allowing a traversal,
/// absolute path, drive prefix or NUL byte.
pub(crate) fn safe_install_path(
    install_dir: &std::path::Path,
    raw_name: &str,
) -> Result<std::path::PathBuf, String> {
    if raw_name.trim().is_empty() {
        return Err("manifest entry has an empty file name".to_string());
    }
    if raw_name.contains('\0') {
        return Err("manifest path contains a NUL byte".to_string());
    }
    let unified = raw_name.replace('\\', "/");
    if unified.starts_with('/') {
        return Err(format!("manifest path is absolute: {raw_name:?}"));
    }
    let mut out = install_dir.to_path_buf();
    let mut depth = 0usize;
    for part in unified.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err(format!("manifest path escapes the install dir: {raw_name:?}")),
            _ => {}
        }
        if part.ends_with(':') {
            return Err(format!("manifest path has a drive prefix: {raw_name:?}"));
        }
        if std::path::Path::new(part)
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            return Err(format!("manifest path has a non-plain component: {raw_name:?}"));
        }
        out.push(part);
        depth += 1;
    }
    if depth == 0 {
        return Err(format!("manifest path resolves to the install dir: {raw_name:?}"));
    }
    if !out.starts_with(install_dir) {
        return Err(format!("manifest path escapes the install dir: {raw_name:?}"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::proto::{push_bytes, push_varint_field};

    fn slice(size: u32, download_size: u32, download: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        push_varint_field(&mut out, 1, u64::from(size));
        push_varint_field(&mut out, 2, u64::from(download_size));
        push_bytes(&mut out, 3, download);
        out
    }

    fn file(name: &str, size: u64, content: &[u8], slices: &[Vec<u8>]) -> Vec<u8> {
        let mut out = Vec::new();
        push_string_field(&mut out, 1, name);
        push_varint_field(&mut out, 2, size);
        push_varint_field(&mut out, 3, 0);
        push_bytes(&mut out, 4, content);
        for slice in slices {
            push_bytes(&mut out, 7, slice);
        }
        out
    }

    fn push_string_field(out: &mut Vec<u8>, field: u32, value: &str) {
        push_bytes(out, field, value.as_bytes());
    }

    #[test]
    fn reads_chunks_files_and_slice_hashes() {
        let one = file(
            "Data\\level.pak",
            8,
            &[0xAA],
            &[slice(8, 32, &[0xBB])],
        );
        let mut chunk = Vec::new();
        push_bytes(&mut chunk, 3, &one);
        let mut manifest = Vec::new();
        push_bytes(&mut manifest, 4, &chunk);
        push_varint_field(&mut manifest, 21, 3);
        let parsed = parse_manifest(&manifest);
        assert_eq!(parsed.compression_method, 3);
        assert_eq!(parsed.files.len(), 1);
        assert_eq!(parsed.files[0].name, "Data\\level.pak");
        assert_eq!(parsed.files[0].size, 8);
        assert_eq!(parsed.files[0].slices.len(), 1);
        assert_eq!(parsed.files[0].slices[0].size, 8);
        assert_eq!(parsed.files[0].slices[0].download_size, Some(32));
        assert_eq!(parsed.files[0].slices[0].download_sha1, vec![0xBB]);
        assert_eq!(parsed.files[0].slices[0].content_sha1, vec![0xAA]);
    }

    #[test]
    fn buckets_slices_like_the_cdn() {
        assert_eq!(hash_path_char("AB"), 'b');
        assert_eq!(hash_path_char("01"), '1');
        assert_eq!(hash_path_char("FF"), 'v');
    }

    #[test]
    fn refuses_manifest_traversal() {
        let root = std::path::Path::new(r"C:\Games\Ubi");
        assert!(safe_install_path(root, r"Data\level.pak").is_ok());
        assert!(safe_install_path(root, r"..\Windows\system32\evil.dll").is_err());
        assert!(safe_install_path(root, r"C:\Windows\evil.dll").is_err());
        assert!(safe_install_path(root, "/etc/passwd").is_err());
        assert!(safe_install_path(root, "Data\\..\\..\\evil.dll").is_err());
    }

    #[tokio::test]
    async fn fetches_a_cdn_manifest_with_the_fixed_header_and_zlib_body() {
        use std::io::Write;

        let one = file("bin\\game.exe", 4, &[0x11], &[slice(4, 8, &[0x22])]);
        let mut chunk = Vec::new();
        push_bytes(&mut chunk, 3, &one);
        let mut manifest_bytes = Vec::new();
        push_bytes(&mut manifest_bytes, 4, &chunk);
        push_varint_field(&mut manifest_bytes, 21, 3);

        let mut body = vec![0u8; 356];
        {
            let mut encoder =
                flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(&manifest_bytes).unwrap();
            body.extend_from_slice(&encoder.finish().unwrap());
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0u8; 4096];
            let _ = socket.read(&mut request).await.unwrap();
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(header.as_bytes()).await.unwrap();
            socket.write_all(&body).await.unwrap();
        });

        let manifest = fetch_manifest(&format!("http://{address}/manifest"))
            .await
            .expect("manifest fetch");
        server.await.unwrap();
        assert_eq!(manifest.files.len(), 1);
        assert_eq!(manifest.files[0].name, "bin\\game.exe");
        assert_eq!(manifest.compression_method, 3);
    }
}
