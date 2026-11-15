//! Smart bypass: a game folder is full of data that is already compressed by
//! the engine, the store or the video encoder. Running zstd over those bytes
//! costs CPU and saves almost nothing, so the packer writes them as stored
//! blocks and keeps the tar member byte for byte identical.

/// Below this size a file shares a frame with its neighbours; the saved CPU is
/// not worth breaking the frame just to skip the compression.
const MIN_BYPASS_BYTES: u64 = 256 * 1024;

/// Extensions that hold an already-compressed stream. The check is on the
/// extension only: it never changes the restored bytes, so a mistake costs
/// compression ratio, not integrity.
const COMPRESSED_EXTENSIONS: &[&str] = &[
    // Video and cinematics.
    "mp4", "m4v", "mkv", "webm", "mov", "wmv", "avi", "bik", "bk2", "usm", "ivf",
    // Audio.
    "mp3", "ogg", "oga", "opus", "aac", "m4a", "flac", "wma", "ac3", "eac3", "dts",
    // Images. DDS, KTX and the Basis family are block-compressed textures.
    "jpg", "jpeg", "png", "apng", "webp", "gif", "dds", "ktx", "ktx2", "basis", "crn",
    "astc", "pvr",
    // Generic containers and single-file compressors.
    "zip", "7z", "rar", "gz", "tgz", "xz", "zst", "bz2", "lz4", "lzma", "lzo", "cab",
    // Engine packs that store compressed streams: Telltale, Unreal IoStore,
    // Wwise and FMOD sound banks.
    "ttarch", "ttarch2", "ucas", "utoc", "wem", "bnk", "fsb",
];

/// True when `rel` should be copied into the archive without zstd. The caller
/// must keep the whole tar member (header, payload and padding) in one stored
/// run, otherwise the member is split across compression modes.
pub fn should_store_raw(rel: &str, size: u64) -> bool {
    if size < MIN_BYPASS_BYTES {
        return false;
    }
    let name = rel.rsplit(['/', '\\']).next().unwrap_or(rel);
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return false;
    };
    if stem.is_empty() || extension.is_empty() {
        return false;
    }
    COMPRESSED_EXTENSIONS
        .iter()
        .any(|known| known.eq_ignore_ascii_case(extension))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_compressed_extensions_are_bypassed() {
        assert!(should_store_raw("video/intro.mp4", 10 * 1024 * 1024));
        assert!(should_store_raw("Archives/Fables_ReBase_ar_txmesh.ttarch2", 3_000_000_000));
        assert!(should_store_raw("audio/voice.WEM", 512 * 1024));
    }

    #[test]
    fn a_short_or_unknown_file_still_compresses() {
        assert!(!should_store_raw("video/intro.mp4", 1024));
        assert!(!should_store_raw("bin/game.exe", 10 * 1024 * 1024));
        assert!(!should_store_raw("readme", 10 * 1024 * 1024));
        assert!(!should_store_raw(".mp4", 10 * 1024 * 1024));
        assert!(should_store_raw("archive.tar.mp4", 10 * 1024 * 1024));
    }
}
