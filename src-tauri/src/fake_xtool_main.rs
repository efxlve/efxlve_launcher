//! Test-only stand-in for xtool. Built only with the `restore-fixture` feature
//! and never shipped.
//!
//! The real xtool is optional and external. This pass-through process lets the
//! CI end-to-end test exercise the xtool-marked archive pipeline (manifest,
//! precompressor requirement, child-process plumbing) without a download. The
//! real xtool round-trip remains covered by the ignored `EFXLVE_XTOOL` tests.

use std::io::{self, Read, Write};

fn main() {
    let mut input = Vec::new();
    let read = io::stdin().read_to_end(&mut input);
    if read.is_err() {
        std::process::exit(1);
    }
    let write = io::stdout().write_all(&input);
    if write.is_err() {
        std::process::exit(1);
    }
}
