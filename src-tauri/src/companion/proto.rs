//! Minimal protobuf wire reader for the launcher catalogs.
//!
//! Only length-delimited messages and varints are required. Unknown fields are
//! skipped so a decryption key or other secret field is never kept.

/// Reads an unsigned varint. Returns the value and the index after it.
pub(crate) fn read_varint(data: &[u8], mut i: usize) -> Option<(u64, usize)> {
    let mut value = 0u64;
    let mut shift = 0;
    while i < data.len() && shift < 64 {
        let byte = data[i];
        i += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some((value, i));
        }
        shift += 7;
    }
    None
}

/// Walks one protobuf message. `on_field` receives field number and payload.
/// Length-delimited payloads are slices. Varints are passed as a one-byte
/// marker plus the numeric value through `on_varint`.
pub(crate) fn for_each_field(data: &[u8], mut on_bytes: impl FnMut(u32, &[u8]), mut on_varint: impl FnMut(u32, u64)) {
    let mut i = 0;
    while i < data.len() {
        let Some((key, next)) = read_varint(data, i) else {
            break;
        };
        let field = (key >> 3) as u32;
        let wire = key & 7;
        if wire == 2 {
            let Some((len, start)) = read_varint(data, next) else {
                break;
            };
            let len = len as usize;
            if start + len > data.len() {
                break;
            }
            on_bytes(field, &data[start..start + len]);
            i = start + len;
        } else if wire == 0 {
            let Some((value, next)) = read_varint(data, next) else {
                break;
            };
            on_varint(field, value);
            i = next;
        } else if wire == 5 {
            if next + 4 > data.len() {
                break;
            }
            i = next + 4;
        } else if wire == 1 {
            if next + 8 > data.len() {
                break;
            }
            i = next + 8;
        } else {
            break;
        }
    }
}

/// Encodes a varint. Test fixtures use this to build catalog bytes.
#[cfg(test)]
pub(crate) fn push_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            break;
        }
    }
}

/// Appends a length-delimited field.
#[cfg(test)]
pub(crate) fn push_bytes(out: &mut Vec<u8>, field: u32, payload: &[u8]) {
    push_varint(out, u64::from(field << 3 | 2));
    push_varint(out, payload.len() as u64);
    out.extend_from_slice(payload);
}

/// Appends a varint field.
#[cfg(test)]
pub(crate) fn push_varint_field(out: &mut Vec<u8>, field: u32, value: u64) {
    push_varint(out, u64::from(field << 3));
    push_varint(out, value);
}
