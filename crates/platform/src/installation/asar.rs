use std::fmt;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::marker::PhantomData;
use std::path::Path;

use serde::de::{Error, MapAccess, Visitor, value::MapAccessDeserializer};
use serde::{Deserialize, Deserializer};

use super::{MAX_VERSION_METADATA_BYTES, parse_package_json_version};

const MAX_HEADER_JSON_BYTES: u64 = 16 * 1024 * 1024;

// The typed projection skips unrelated files instead of allocating a JSON tree
// for the entire archive. Require objects rather than Serde's positional form.
fn deserialize_object<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct Object<T>(PhantomData<T>);

    impl<'de, T: Deserialize<'de>> Visitor<'de> for Object<T> {
        type Value = T;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("an ASAR JSON object")
        }

        fn visit_map<M: MapAccess<'de>>(self, map: M) -> Result<T, M::Error> {
            T::deserialize(MapAccessDeserializer::new(map))
        }
    }

    deserializer.deserialize_map(Object(PhantomData))
}

#[derive(Deserialize)]
struct Header(#[serde(deserialize_with = "deserialize_object")] HeaderFields);

#[derive(Deserialize)]
struct HeaderFields {
    #[serde(deserialize_with = "deserialize_object")]
    files: RootFiles,
}

#[derive(Deserialize)]
struct RootFiles {
    #[serde(rename = "package.json", deserialize_with = "deserialize_object")]
    package_json: PackageEntry,
}

#[derive(Deserialize)]
struct PackageEntry {
    size: u64,
    #[serde(deserialize_with = "deserialize_offset")]
    offset: u64,
    #[serde(default)]
    unpacked: bool,
}

fn deserialize_offset<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    struct Offset;

    impl<'de> Visitor<'de> for Offset {
        type Value = u64;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("an unsigned ASAR offset (integer or decimal string)")
        }

        fn visit_u64<E: Error>(self, value: u64) -> Result<u64, E> {
            Ok(value)
        }

        fn visit_str<E: Error>(self, value: &str) -> Result<u64, E> {
            value.parse().map_err(E::custom)
        }
    }

    deserializer.deserialize_any(Offset)
}

/// Best-effort read of the packed root `package.json`; never follows links or
/// descends into `node_modules`.
pub(super) fn parse_asar_package_json_version(asar_path: &Path) -> Option<String> {
    let mut file = File::open(asar_path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    let file_len = metadata.len();
    let mut prefix = [0_u8; 16];
    file.read_exact(&mut prefix).ok()?;

    // Two Pickles: a uint32 giving the header size, then a length-prefixed
    // JSON string padded to a four-byte boundary.
    let field = |start| {
        let bytes = prefix.get(start..start + 4)?.try_into().ok()?;
        Some(u64::from(u32::from_le_bytes(bytes)))
    };
    let header_size = field(4)?;
    let payload_size = field(8)?;
    let json_len = field(12)?;
    if field(0)? != 4 || !(1..=MAX_HEADER_JSON_BYTES).contains(&json_len) {
        return None;
    }
    let content_start = 8 + header_size;
    if payload_size != 4 + json_len.next_multiple_of(4)
        || header_size != 4 + payload_size
        || content_start > file_len
    {
        return None;
    }

    let mut json = vec![0; usize::try_from(json_len).ok()?];
    file.read_exact(&mut json).ok()?;
    let Header(header) = serde_json::from_str(std::str::from_utf8(&json).ok()?).ok()?;
    let PackageEntry {
        size,
        offset,
        unpacked,
    } = header.files.package_json;
    if unpacked || !(1..=MAX_VERSION_METADATA_BYTES).contains(&size) {
        return None;
    }
    let file_offset = content_start.checked_add(offset)?;
    if file_offset.checked_add(size)? > file_len {
        return None;
    }

    file.seek(SeekFrom::Start(file_offset)).ok()?;
    let mut package_json = vec![0; usize::try_from(size).ok()?];
    file.read_exact(&mut package_json).ok()?;
    parse_package_json_version(std::str::from_utf8(&package_json).ok()?)
}
