use std::cmp::Ordering;

#[cfg(windows)]
#[link(name = "shlwapi")]
unsafe extern "system" {
    fn StrCmpLogicalW(left: *const u16, right: *const u16) -> i32;
}

/// Uses Windows Explorer's own logical comparator on Windows. Other targets
/// retain the portable case-insensitive numeric fallback used by PixVault.
#[cfg(windows)]
pub(crate) fn explorer_name_cmp(left: &str, right: &str) -> Ordering {
    let left_wide = left
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let right_wide = right
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: Both buffers are NUL-terminated UTF-16 strings and remain alive
    // for the duration of this read-only Win32 comparison.
    unsafe { StrCmpLogicalW(left_wide.as_ptr(), right_wide.as_ptr()) }.cmp(&0)
}

#[cfg(not(windows))]
pub(crate) fn explorer_name_cmp(left: &str, right: &str) -> Ordering {
    let left_folded = left.to_lowercase();
    let right_folded = right.to_lowercase();
    let left_bytes = left_folded.as_bytes();
    let right_bytes = right_folded.as_bytes();
    let (mut left_index, mut right_index) = (0, 0);

    while left_index < left_bytes.len() && right_index < right_bytes.len() {
        if left_bytes[left_index].is_ascii_digit() && right_bytes[right_index].is_ascii_digit() {
            let left_start = left_index;
            let right_start = right_index;
            while left_index < left_bytes.len() && left_bytes[left_index].is_ascii_digit() {
                left_index += 1;
            }
            while right_index < right_bytes.len() && right_bytes[right_index].is_ascii_digit() {
                right_index += 1;
            }
            let left_digits = &left_bytes[left_start..left_index];
            let right_digits = &right_bytes[right_start..right_index];
            let left_significant = &left_digits[left_digits
                .iter()
                .position(|byte| *byte != b'0')
                .unwrap_or(left_digits.len())..];
            let right_significant = &right_digits[right_digits
                .iter()
                .position(|byte| *byte != b'0')
                .unwrap_or(right_digits.len())..];
            match left_significant
                .len()
                .cmp(&right_significant.len())
                .then_with(|| left_significant.cmp(right_significant))
                .then_with(|| left_digits.len().cmp(&right_digits.len()))
            {
                Ordering::Equal => {}
                ordering => return ordering,
            }
            continue;
        }
        match left_bytes[left_index].cmp(&right_bytes[right_index]) {
            Ordering::Equal => {
                left_index += 1;
                right_index += 1;
            }
            ordering => return ordering,
        }
    }

    left_bytes
        .len()
        .cmp(&right_bytes.len())
        .then_with(|| left.cmp(right))
}
