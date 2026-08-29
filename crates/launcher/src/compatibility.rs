use serde::Deserialize;

pub const MAX_CONTROLLER_READINESS_LINE_BYTES: usize = 513;
const CONTROLLER_READINESS_SCHEMA_VERSION: u8 = 2;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ControllerReadinessState {
    Compatible,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ControllerReadiness {
    schema_version: u8,
    state: ControllerReadinessState,
    issues: Vec<serde_json::Value>,
}

impl ControllerReadiness {
    fn validate(&self) -> Result<(), String> {
        if self.schema_version != CONTROLLER_READINESS_SCHEMA_VERSION {
            return Err(format!(
                "unsupported Desktop Controller readiness version {}",
                self.schema_version
            ));
        }
        if self.state != ControllerReadinessState::Compatible || !self.issues.is_empty() {
            return Err("Desktop Controller readiness must be compatible with no issues".into());
        }
        Ok(())
    }
}

pub fn parse_controller_readiness_line(bytes: &[u8]) -> Result<ControllerReadiness, String> {
    if bytes.is_empty() || bytes.len() > MAX_CONTROLLER_READINESS_LINE_BYTES {
        return Err("Desktop Controller readiness line has an invalid size".into());
    }
    if !bytes.ends_with(b"\n") || bytes[..bytes.len() - 1].contains(&b'\n') {
        return Err(
            "Desktop Controller readiness must be exactly one newline-terminated line".into(),
        );
    }
    let payload = &bytes[..bytes.len() - 1];
    if payload.contains(&b'\r') {
        return Err("Desktop Controller readiness contains an invalid carriage return".into());
    }
    let readiness = serde_json::from_slice::<ControllerReadiness>(payload)
        .map_err(|error| format!("invalid Desktop Controller readiness: {error}"))?;
    readiness.validate()?;
    Ok(readiness)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_the_strict_compatible_readiness() {
        parse_controller_readiness_line(
            b"{\"schemaVersion\":2,\"state\":\"compatible\",\"issues\":[]}\n",
        )
        .expect("valid compatible readiness");

        for invalid in [
            b"{\"schemaVersion\":2,\"state\":\"compatible-with-warning\",\"issues\":[{}]}\n"
                .as_slice(),
            b"{\"schemaVersion\":2,\"state\":\"degraded\",\"issues\":[{}]}\n".as_slice(),
            b"{\"schemaVersion\":2,\"state\":\"compatible\",\"issues\":[{}]}\n".as_slice(),
            b"{\"schemaVersion\":3,\"state\":\"compatible\",\"issues\":[]}\n".as_slice(),
            b"{\"schemaVersion\":2,\"state\":\"compatible\",\"issues\":[],\"extra\":true}\n"
                .as_slice(),
            b"ready\n".as_slice(),
        ] {
            assert!(parse_controller_readiness_line(invalid).is_err());
        }
    }

    #[test]
    fn rejects_unbounded_or_multiline_readiness() {
        assert!(
            parse_controller_readiness_line(
                b"{\"schemaVersion\":2,\"state\":\"compatible\",\"issues\":[]}\nextra\n"
            )
            .is_err()
        );
        assert!(
            parse_controller_readiness_line(&vec![b'a'; MAX_CONTROLLER_READINESS_LINE_BYTES + 1])
                .is_err()
        );
    }
}
