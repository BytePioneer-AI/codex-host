//! Bounded reads of Desktop product metadata; MSIX deployment identity lives elsewhere.
#[cfg(target_os = "windows")]
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
#[cfg(target_os = "windows")]
use std::path::Path;

use serde_json::Value;

const MAX_HEADER_BYTES: u32 = 32 * 1024 * 1024;
const MAX_PACKAGE_BYTES: u64 = 64 * 1024;

#[cfg(target_os = "windows")]
pub(crate) fn desktop_product_version(path: &Path) -> Option<String> {
    read_product_version(&mut File::open(path).ok()?)
}

fn read_product_version(reader: &mut (impl Read + Seek)) -> Option<String> {
    let length = reader.seek(SeekFrom::End(0)).ok()?;
    reader.seek(SeekFrom::Start(0)).ok()?;
    let mut prefix = [0_u8; 16];
    reader.read_exact(&mut prefix).ok()?;
    let word = |offset| {
        u32::from_le_bytes(
            prefix[offset..offset + 4]
                .try_into()
                .expect("four-byte prefix word"),
        )
    };
    let header_size = word(4);
    let json_size = word(12);
    if word(0) != 4
        || !(8..=MAX_HEADER_BYTES).contains(&header_size)
        || word(8) != header_size - 4
        || json_size > header_size - 8
    {
        return None;
    }
    let data_start = 8 + u64::from(header_size);
    if data_start > length {
        return None;
    }
    let mut header = vec![0; json_size as usize];
    reader.read_exact(&mut header).ok()?;
    let header: Value = serde_json::from_slice(&header).ok()?;
    let entry = header.get("files")?.get("package.json")?;
    if entry.get("link").is_some() || entry.get("unpacked").is_some_and(|v| v != false) {
        return None;
    }
    let size = entry.get("size")?.as_u64()?;
    if size == 0 || size > MAX_PACKAGE_BYTES {
        return None;
    }
    let offset = entry.get("offset")?.as_str()?.parse::<u64>().ok()?;
    let start = data_start.checked_add(offset)?;
    if start.checked_add(size)? > length {
        return None;
    }
    reader.seek(SeekFrom::Start(start)).ok()?;
    let mut package = vec![0; size as usize];
    reader.read_exact(&mut package).ok()?;
    let package: Value = serde_json::from_slice(&package).ok()?;
    let version = package.get("version")?.as_str()?;
    let components: Vec<_> = version.split('.').collect();
    (version.len() <= 64
        && components.len() == 3
        && components
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit())))
    .then(|| version.to_owned())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    pub(crate) fn archive(entry: Value, package: &[u8]) -> Vec<u8> {
        let header = serde_json::to_vec(&json!({"files":{"package.json":entry}})).unwrap();
        let header_size = (8 + header.len()).next_multiple_of(4) as u32;
        let mut bytes = Vec::new();
        for word in [4, header_size, header_size - 4, header.len() as u32] {
            bytes.extend_from_slice(&word.to_le_bytes());
        }
        bytes.extend_from_slice(&header);
        bytes.resize(8 + header_size as usize, 0);
        bytes.extend_from_slice(package);
        bytes
    }

    #[test]
    fn reads_product_version_independently_of_msix_deployment_version() {
        let package = br#"{"version":"26.1021.31345"}"#;
        let bytes = archive(json!({"size":package.len(),"offset":"0"}), package);
        assert_eq!(
            read_product_version(&mut Cursor::new(bytes)).as_deref(),
            Some("26.1021.31345")
        );
    }

    #[test]
    fn rejects_oversized_truncated_unpacked_linked_and_out_of_bounds_entries() {
        let package = br#"{"version":"26.1021.31345"}"#;
        for entry in [
            json!({"size":MAX_PACKAGE_BYTES+1,"offset":"0"}),
            json!({"size":package.len(),"offset":"18446744073709551615"}),
            json!({"size":package.len()+1,"offset":"0"}),
            json!({"size":package.len(),"offset":"0","unpacked":true}),
            json!({"size":package.len(),"offset":"0","link":"elsewhere"}),
        ] {
            assert!(read_product_version(&mut Cursor::new(archive(entry, package))).is_none());
        }
        let mut bytes = archive(json!({"size":package.len(),"offset":"0"}), package);
        bytes[4..8].copy_from_slice(&(MAX_HEADER_BYTES + 1).to_le_bytes());
        assert!(read_product_version(&mut Cursor::new(bytes)).is_none());
        assert!(read_product_version(&mut Cursor::new(b"not an asar")).is_none());
    }

    #[test]
    fn rejects_invalid_product_metadata_and_four_part_package_versions() {
        for package in [
            b"{}".as_slice(),
            b"invalid",
            br#"{"version":"26.1021.3705.0"}"#,
            br#"{"version":"26..31345"}"#,
        ] {
            assert!(
                read_product_version(&mut Cursor::new(archive(
                    json!({"size":package.len(),"offset":"0"}),
                    package
                )))
                .is_none()
            );
        }
    }
}
