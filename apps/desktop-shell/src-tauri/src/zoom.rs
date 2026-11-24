use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub(crate) const ZOOM_FILE: &str = "desktop-shell-zoom-v1.json";
pub(crate) const DEFAULT_ZOOM_PERCENT: u16 = 100;
pub(crate) const ZOOM_LADDER: [u16; 11] = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ZoomState {
    pub percent: u16,
    pub ladder: &'static [u16],
    pub revision: u64,
}

#[derive(Serialize, Deserialize)]
struct ZoomRecord {
    percent: u16,
}

#[derive(Debug)]
pub(crate) struct ZoomController {
    percent: u16,
    revision: u64,
}

impl ZoomController {
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join(ZOOM_FILE);
        let percent = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ZoomRecord>(&bytes).ok())
            .map(|record| snap_percent(record.percent))
            .unwrap_or(DEFAULT_ZOOM_PERCENT);
        Self {
            percent,
            revision: 0,
        }
    }

    pub fn state(&self) -> ZoomState {
        ZoomState {
            percent: self.percent,
            ladder: &ZOOM_LADDER,
            revision: self.revision,
        }
    }

    pub fn percent(&self) -> u16 {
        self.percent
    }

    pub fn scale(&self) -> f64 {
        percent_to_scale(self.percent)
    }

    pub fn resolve_step(&self, delta: i8) -> Result<u16, String> {
        let current_idx = ZOOM_LADDER
            .iter()
            .position(|&value| value == self.percent)
            .expect("zoom percent is always a member of ZOOM_LADDER");
        let next_idx = match delta {
            1 => current_idx.saturating_add(1).min(ZOOM_LADDER.len() - 1),
            -1 => current_idx.saturating_sub(1),
            _ => return Err(format!("Invalid zoom step direction: {delta}")),
        };
        Ok(ZOOM_LADDER[next_idx])
    }

    pub fn resolve_set(&self, percent: u16) -> Result<u16, String> {
        if !ZOOM_LADDER.contains(&percent) {
            return Err(format!("Unsupported zoom percent: {percent}"));
        }
        Ok(percent)
    }

    pub fn commit(&mut self, percent: u16) -> (ZoomState, bool) {
        debug_assert!(ZOOM_LADDER.contains(&percent));
        if percent == self.percent {
            return (self.state(), false);
        }
        self.percent = percent;
        self.revision = self.revision.saturating_add(1);
        (self.state(), true)
    }
}

pub(crate) fn percent_to_scale(percent: u16) -> f64 {
    f64::from(percent) / 100.0
}

pub(crate) fn snap_percent(percent: u16) -> u16 {
    let min = ZOOM_LADDER[0];
    let max = ZOOM_LADDER[ZOOM_LADDER.len() - 1];
    if percent < min || percent > max {
        return DEFAULT_ZOOM_PERCENT;
    }
    let mut best = DEFAULT_ZOOM_PERCENT;
    let mut best_distance = u16::MAX;
    for &candidate in &ZOOM_LADDER {
        let distance = candidate.abs_diff(percent);
        if distance < best_distance
            || (distance == best_distance && candidate == DEFAULT_ZOOM_PERCENT)
        {
            best = candidate;
            best_distance = distance;
        }
    }
    best
}

pub(crate) fn persist(data_dir: &Path, percent: u16) -> Result<PathBuf, std::io::Error> {
    fs::create_dir_all(data_dir)?;
    let path = data_dir.join(ZOOM_FILE);
    // NamedTempFile creates the temporary file with 0o600 permissions on Unix.
    let mut file = tempfile::NamedTempFile::new_in(data_dir)?;
    serde_json::to_writer(&mut file, &ZoomRecord { percent })?;
    writeln!(file)?;
    file.as_file().sync_all()?;
    file.persist(&path).map_err(|error| error.error)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_across_ladder_without_exceeding_bounds_and_tracks_revision() {
        let dir = tempfile::tempdir().unwrap();
        let mut ctrl = ZoomController::load(dir.path());
        assert_eq!(ctrl.percent(), 100);
        assert_eq!(ctrl.state().revision, 0);

        let mut expected_rev = 0u64;
        for (expected, should_change) in [
            (110, true),
            (125, true),
            (150, true),
            (175, true),
            (200, true),
            (200, false),
        ] {
            let next = ctrl.resolve_step(1).unwrap();
            let (state, changed) = ctrl.commit(next);
            if should_change {
                expected_rev += 1;
            }
            assert_eq!(state.percent, expected);
            assert_eq!(changed, should_change);
            assert_eq!(state.revision, expected_rev);
        }
        for (expected, should_change) in [
            (175, true),
            (150, true),
            (125, true),
            (110, true),
            (100, true),
            (90, true),
            (80, true),
            (75, true),
            (67, true),
            (50, true),
            (50, false),
        ] {
            let next = ctrl.resolve_step(-1).unwrap();
            let (state, changed) = ctrl.commit(next);
            if should_change {
                expected_rev += 1;
            }
            assert_eq!(state.percent, expected);
            assert_eq!(changed, should_change);
            assert_eq!(state.revision, expected_rev);
        }
        assert!(ctrl.resolve_step(0).is_err());
        assert!(ctrl.resolve_step(2).is_err());
    }

    #[test]
    fn set_accepts_only_ladder_presets() {
        let dir = tempfile::tempdir().unwrap();
        let mut ctrl = ZoomController::load(dir.path());
        let next = ctrl.resolve_set(150).unwrap();
        assert_eq!(ctrl.commit(next).0.percent, 150);
        let reset = ctrl.resolve_set(100).unwrap();
        assert_eq!(ctrl.commit(reset).0.percent, 100);
        assert!(ctrl.resolve_set(120).is_err());
        assert!(ctrl.resolve_set(25).is_err());
        assert!(ctrl.resolve_set(300).is_err());
    }

    #[test]
    fn snaps_in_range_and_resets_corrupt_or_out_of_range_files() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(ZOOM_FILE);

        fs::write(&file, "{not json").unwrap();
        assert_eq!(ZoomController::load(dir.path()).percent(), 100);

        fs::write(&file, r#"{"percent": 25}"#).unwrap();
        assert_eq!(ZoomController::load(dir.path()).percent(), 100);

        fs::write(&file, r#"{"percent": 999}"#).unwrap();
        assert_eq!(ZoomController::load(dir.path()).percent(), 100);

        fs::write(&file, r#"{"percent": 120}"#).unwrap();
        assert_eq!(ZoomController::load(dir.path()).percent(), 125);

        fs::write(&file, r#"{"percent": 95}"#).unwrap();
        assert_eq!(ZoomController::load(dir.path()).percent(), 100);
    }

    #[test]
    fn persists_and_reloads_atomically_with_restrictive_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let saved = persist(dir.path(), 125).unwrap();
        assert_eq!(saved, dir.path().join(ZOOM_FILE));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&saved).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let reloaded = ZoomController::load(dir.path());
        assert_eq!(reloaded.percent(), 125);
        assert!((reloaded.scale() - 1.25).abs() < f64::EPSILON);
    }
}
