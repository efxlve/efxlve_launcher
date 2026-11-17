//! Reed-Solomon parity over GF(256), the first building block for a future
//! format version 3. Nothing writes or reads parity files yet; `mod.rs` allows
//! dead code until the packer and restorer are wired to it.
//!
//! The planned v3 layout is:
//! - `manifest.parity` carries `dataShards`, `parityShards`, `shardBytes` and
//!   one `efxpar.NNN` file per parity shard (see `format::ParityInfo`);
//! - the archive stream is split into equal shards (the last one zero-padded),
//!   and any `dataShards` of the data and parity shards recover the stream;
//! - a corrupt shard is treated as missing after its SHA-256 check fails;
//! - the format version stays 2 until packing and restoring actually use it.

use std::sync::OnceLock;

const MAX_SHARDS: usize = 255;
const GF_POLY: u16 = 0x11d;

struct Tables {
    exp: [u8; 512],
    log: [u8; 256],
}

fn tables() -> &'static Tables {
    static TABLES: OnceLock<Tables> = OnceLock::new();
    TABLES.get_or_init(|| {
        let mut exp = [0u8; 512];
        let mut log = [0u8; 256];
        let mut value: u16 = 1;
        for (index, slot) in exp.iter_mut().take(255).enumerate() {
            *slot = value as u8;
            log[value as usize] = index as u8;
            value <<= 1;
            if value & 0x100 != 0 {
                value ^= GF_POLY;
            }
        }
        exp.copy_within(0..255, 255);
        exp[510] = exp[0];
        exp[511] = exp[1];
        Tables { exp, log }
    })
}

fn gf_mul(left: u8, right: u8) -> u8 {
    if left == 0 || right == 0 {
        return 0;
    }
    let table = tables();
    table.exp[table.log[left as usize] as usize + table.log[right as usize] as usize]
}

fn gf_inv(value: u8) -> u8 {
    let table = tables();
    table.exp[255 - table.log[value as usize] as usize]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParityLayout {
    data_shards: usize,
    parity_shards: usize,
}

impl ParityLayout {
    pub fn new(data_shards: usize, parity_shards: usize) -> Result<Self, String> {
        if data_shards == 0 || parity_shards == 0 {
            return Err("data and parity shard counts must be positive".to_string());
        }
        if data_shards + parity_shards > MAX_SHARDS {
            return Err(format!(
                "data + parity shards must not exceed {MAX_SHARDS}"
            ));
        }
        Ok(Self {
            data_shards,
            parity_shards,
        })
    }

    pub fn data_shards(&self) -> usize {
        self.data_shards
    }

    pub fn parity_shards(&self) -> usize {
        self.parity_shards
    }

    pub fn total_shards(&self) -> usize {
        self.data_shards + self.parity_shards
    }

    /// One row of the systematic generator `[I; P]`. `P` is a Cauchy matrix:
    /// `P[r][c] = 1 / (x_r XOR y_c)` with disjoint `x = 0..parity` and
    /// `y = parity..parity + data`. Every square submatrix of a Cauchy matrix is
    /// invertible, so any `data_shards` rows recover the data.
    fn generator_row(&self, row: usize) -> Vec<u8> {
        if row < self.data_shards {
            let mut out = vec![0u8; self.data_shards];
            out[row] = 1;
            return out;
        }
        let parity_row = row - self.data_shards;
        (0..self.data_shards)
            .map(|column| {
                let x = parity_row as u8;
                let y = (self.parity_shards + column) as u8;
                gf_inv(x ^ y)
            })
            .collect()
    }
}

/// Splits `data` into parity shards of the same length. Every data shard must
/// have the same length; the caller zero-pads the last shard of a volume.
pub fn encode(layout: ParityLayout, data: &[Vec<u8>]) -> Result<Vec<Vec<u8>>, String> {
    if data.len() != layout.data_shards {
        return Err(format!(
            "expected {} data shards, got {}",
            layout.data_shards,
            data.len()
        ));
    }
    let shard_len = data.first().map(Vec::len).unwrap_or(0);
    if data.iter().any(|shard| shard.len() != shard_len) {
        return Err("data shards must all have the same length".to_string());
    }

    let mut parity = Vec::with_capacity(layout.parity_shards);
    for parity_row in 0..layout.parity_shards {
        let mut out = vec![0u8; shard_len];
        for (column, shard) in data.iter().enumerate() {
            let factor = gf_inv((parity_row as u8) ^ ((layout.parity_shards + column) as u8));
            for (target, byte) in out.iter_mut().zip(shard) {
                *target ^= gf_mul(*byte, factor);
            }
        }
        parity.push(out);
    }
    Ok(parity)
}

/// Recovers the data shards from any `data_shards` available entries. `shards`
/// is laid out as data shards followed by parity shards; `None` marks a missing
/// or corrupt shard. More than `parity_shards` erasures are rejected.
pub fn recover(layout: ParityLayout, shards: &[Option<Vec<u8>>]) -> Result<Vec<Vec<u8>>, String> {
    if shards.len() != layout.total_shards() {
        return Err(format!(
            "expected {} shards, got {}",
            layout.total_shards(),
            shards.len()
        ));
    }
    let available: Vec<usize> = shards
        .iter()
        .enumerate()
        .filter_map(|(index, shard)| shard.as_ref().map(|_| index))
        .collect();
    if available.len() < layout.data_shards {
        return Err(format!(
            "not enough shards to recover: need {}, have {}",
            layout.data_shards,
            available.len()
        ));
    }
    let shard_len = shards
        .iter()
        .flatten()
        .next()
        .map(Vec::len)
        .unwrap_or(0);
    if shards
        .iter()
        .flatten()
        .any(|shard| shard.len() != shard_len)
    {
        return Err("available shards must all have the same length".to_string());
    }

    let selected: Vec<usize> = available.into_iter().take(layout.data_shards).collect();
    let matrix: Vec<Vec<u8>> = selected
        .iter()
        .map(|row| layout.generator_row(*row))
        .collect();
    let inverse = invert(&matrix)?;

    let mut recovered = vec![vec![0u8; shard_len]; layout.data_shards];
    for (row, shard_index) in selected.iter().enumerate() {
        let Some(shard) = shards[*shard_index].as_ref() else {
            continue;
        };
        for (column, output) in recovered.iter_mut().enumerate() {
            let factor = inverse[column][row];
            for (target, byte) in output.iter_mut().zip(shard) {
                *target ^= gf_mul(*byte, factor);
            }
        }
    }
    Ok(recovered)
}

fn invert(matrix: &[Vec<u8>]) -> Result<Vec<Vec<u8>>, String> {
    let size = matrix.len();
    if size == 0 || matrix.iter().any(|row| row.len() != size) {
        return Err("the shard matrix is not square".to_string());
    }
    let mut augmented = vec![vec![0u8; size * 2]; size];
    for row in 0..size {
        augmented[row][..size].copy_from_slice(&matrix[row]);
        augmented[row][size + row] = 1;
    }

    for column in 0..size {
        let pivot = (column..size)
            .find(|row| augmented[*row][column] != 0)
            .ok_or_else(|| "the shard matrix is singular".to_string())?;
        if pivot != column {
            augmented.swap(pivot, column);
        }
        let inverse = gf_inv(augmented[column][column]);
        for value in &mut augmented[column] {
            *value = gf_mul(*value, inverse);
        }
        let pivot_row = augmented[column].clone();
        for (row, values) in augmented.iter_mut().enumerate() {
            if row == column || values[column] == 0 {
                continue;
            }
            let factor = values[column];
            for (target, pivot) in values.iter_mut().zip(&pivot_row) {
                *target ^= gf_mul(factor, *pivot);
            }
        }
    }

    Ok(augmented
        .into_iter()
        .map(|row| row[size..].to_vec())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(count: usize, len: usize) -> Vec<Vec<u8>> {
        (0..count)
            .map(|shard| {
                (0..len)
                    .map(|index| (shard * 37 + index * 11) as u8)
                    .collect()
            })
            .collect()
    }

    #[test]
    fn encode_and_recover_after_two_erasures() {
        let layout = ParityLayout::new(3, 2).unwrap();
        let original = data(3, 64);
        let parity = encode(layout, &original).unwrap();
        assert_eq!(parity.len(), 2);

        let mut shards: Vec<Option<Vec<u8>>> = original
            .iter()
            .cloned()
            .map(Some)
            .chain(parity.into_iter().map(Some))
            .collect();
        shards[1] = None;
        shards[3] = None;

        assert_eq!(recover(layout, &shards).unwrap(), original);
    }

    #[test]
    fn recovers_when_parity_is_the_majority() {
        let layout = ParityLayout::new(2, 3).unwrap();
        let original = data(2, 32);
        let parity = encode(layout, &original).unwrap();
        let mut shards: Vec<Option<Vec<u8>>> = original
            .iter()
            .cloned()
            .map(Some)
            .chain(parity.into_iter().map(Some))
            .collect();
        shards[0] = None;
        shards[1] = None;

        assert_eq!(recover(layout, &shards).unwrap(), original);
    }

    #[test]
    fn rejects_more_erasures_than_parity_shards() {
        let layout = ParityLayout::new(3, 2).unwrap();
        let original = data(3, 16);
        let parity = encode(layout, &original).unwrap();
        let mut shards: Vec<Option<Vec<u8>>> = original
            .iter()
            .cloned()
            .map(Some)
            .chain(parity.into_iter().map(Some))
            .collect();
        shards[0] = None;
        shards[1] = None;
        shards[3] = None;

        let error = recover(layout, &shards).unwrap_err();
        assert!(error.contains("not enough shards"), "{error}");
    }

    #[test]
    fn corrupt_shards_are_treated_as_erasures() {
        let layout = ParityLayout::new(4, 2).unwrap();
        let original = data(4, 48);
        let parity = encode(layout, &original).unwrap();
        let mut shards: Vec<Option<Vec<u8>>> = original
            .iter()
            .cloned()
            .map(Some)
            .chain(parity.into_iter().map(Some))
            .collect();
        shards[2] = None;
        shards[5] = None;

        assert_eq!(recover(layout, &shards).unwrap(), original);
    }

    #[test]
    fn invalid_layouts_are_rejected() {
        assert!(ParityLayout::new(0, 1).is_err());
        assert!(ParityLayout::new(1, 0).is_err());
        assert!(ParityLayout::new(200, 56).is_err());
        assert!(ParityLayout::new(200, 55).is_ok());
    }

    #[test]
    fn mismatched_shard_shapes_are_rejected() {
        let layout = ParityLayout::new(2, 1).unwrap();
        let bad = vec![vec![1u8; 8], vec![2u8; 9]];
        assert!(encode(layout, &bad).is_err());
    }
}
