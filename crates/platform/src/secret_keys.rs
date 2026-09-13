//! Read-only access to legacy 32-byte secrets in the operating system credential store.
//! No caller-specific authentication, account, or Host semantics belong here.

use keyring::{Entry, Error as KeyringError};

use crate::PlatformError;

pub const NATIVE_SECRET_KEY_BYTES: usize = 32;
pub const NATIVE_SECRET_KEY_SERVICE: &str = "codexhost.native-accounts.v1";

fn validate_key_id(key_id: &str) -> Result<(), PlatformError> {
    if key_id.len() != 64
        || !key_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(PlatformError::Invalid(
            "native secret key identifier is invalid".into(),
        ));
    }
    Ok(())
}

fn entry(key_id: &str) -> Result<Entry, PlatformError> {
    validate_key_id(key_id)?;
    Entry::new(NATIVE_SECRET_KEY_SERVICE, key_id)
        .map_err(|_| PlatformError::Unsupported("operating system secret storage is unavailable"))
}

fn decode(secret: Vec<u8>) -> Result<[u8; NATIVE_SECRET_KEY_BYTES], PlatformError> {
    secret
        .try_into()
        .map_err(|_| PlatformError::Invalid("native secret key has an unexpected length".into()))
}

pub fn read_secret_key(
    key_id: &str,
) -> Result<Option<[u8; NATIVE_SECRET_KEY_BYTES]>, PlatformError> {
    match entry(key_id)?.get_secret() {
        Ok(secret) => decode(secret).map(Some),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(_) => Err(PlatformError::Unsupported(
            "operating system secret storage is unavailable",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_sha256_hex_identifier_shape_without_accessing_the_os_store() {
        assert!(validate_key_id(&"a".repeat(64)).is_ok());
        for invalid in ["", "a", &"A".repeat(64), &"g".repeat(64), &"a".repeat(65)] {
            assert!(validate_key_id(invalid).is_err());
        }
    }
}
