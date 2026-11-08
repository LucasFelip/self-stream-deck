//! SMTC (the System Media Transport Controls, what the volume flyout shows) for the `MediaPort`. Same answers as
//! `legacy/server/native/MediaOps.cs`, but through the typed WinRT projection instead of `dynamic` (ADR 0008: 12 ms for a full read).
use std::time::{SystemTime, UNIX_EPOCH};

use ssd_core::media::{app_name, art_key};
use ssd_core::ports::{
    Art, MediaAction, MediaPort, MediaSession, MediaState, PortError, PortResult,
};
use windows::core::Interface;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
};
use windows::Storage::Streams::{DataReader, IInputStream};

use crate::audio::com;

/// Ticks (100 ns) between 1601-01-01, where WinRT dates start, and 1970-01-01.
const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;
const TICKS_PER_SECOND: f64 = 10_000_000.0;

fn failed(error: windows::core::Error) -> PortError {
    PortError::Failed(error.message())
}

fn manager() -> PortResult<Manager> {
    com();
    Manager::RequestAsync()
        .and_then(|operation| operation.get())
        .map_err(failed)
}

fn find(manager: &Manager, id: &str) -> PortResult<Session> {
    let sessions = manager.GetSessions().map_err(failed)?;
    for session in sessions {
        if session
            .SourceAppUserModelId()
            .map(|h| h.to_string())
            .is_ok_and(|candidate| candidate == id)
        {
            return Ok(session);
        }
    }
    Err(PortError::Failed("media session not found".into()))
}

fn status_name(status: i32) -> &'static str {
    match status {
        0 => "closed",
        1 => "opened",
        2 => "changing",
        3 => "stopped",
        4 => "playing",
        _ => "paused",
    }
}

fn describe(session: &Session) -> windows::core::Result<MediaSession> {
    let id = session.SourceAppUserModelId()?.to_string();
    let props = session.TryGetMediaPropertiesAsync()?.get()?;
    let playback = session.GetPlaybackInfo()?;
    let timeline = session.GetTimelineProperties()?;
    let status = status_name(playback.PlaybackStatus()?.0);

    let start = timeline.StartTime()?.Duration;
    let duration = (timeline.EndTime()?.Duration - start) as f64 / TICKS_PER_SECOND;
    let mut position = (timeline.Position()?.Duration - start) as f64 / TICKS_PER_SECOND;
    let (mut duration_value, mut position_value) = (None, None);
    if duration > 0.0 {
        // the timeline is a snapshot taken at LastUpdatedTime; move it forward while playing
        if status == "playing" {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| (d.as_nanos() / 100) as i64)
                .unwrap_or(0)
                + UNIX_EPOCH_TICKS;
            let elapsed =
                (now - timeline.LastUpdatedTime()?.UniversalTime) as f64 / TICKS_PER_SECOND;
            if elapsed > 0.0 {
                position += elapsed;
            }
        }
        duration_value = Some(duration);
        position_value = Some(position.clamp(0.0, duration));
    }

    let (title, artist, album) = (
        props.Title()?.to_string(),
        props.Artist()?.to_string(),
        props.AlbumTitle()?.to_string(),
    );
    let controls = playback.Controls()?;
    Ok(MediaSession {
        app: app_name(&id),
        status: status.into(),
        duration: duration_value,
        position: position_value,
        can_play: controls.IsPlayEnabled()?,
        can_pause: controls.IsPauseEnabled()?,
        can_prev: controls.IsPreviousEnabled()?,
        can_next: controls.IsNextEnabled()?,
        can_seek: controls.IsPlaybackPositionEnabled()?,
        has_art: props.Thumbnail().is_ok(),
        art_key: art_key(&id, &title, &artist, &album),
        id,
        title,
        artist,
        album,
    })
}

#[derive(Default)]
pub struct WindowsMedia;

impl MediaPort for WindowsMedia {
    fn state(&self) -> PortResult<MediaState> {
        let manager = manager()?;
        let current = manager
            .GetCurrentSession()
            .ok()
            .and_then(|s| s.SourceAppUserModelId().ok())
            .map(|h| h.to_string());
        let mut sessions = Vec::new();
        for session in manager.GetSessions().map_err(failed)? {
            sessions.push(describe(&session).map_err(failed)?);
        }
        Ok(MediaState { current, sessions })
    }

    fn control(&self, session: &str, action: MediaAction) -> PortResult<bool> {
        let session = find(&manager()?, session)?;
        let operation = match action {
            MediaAction::Toggle => session.TryTogglePlayPauseAsync(),
            MediaAction::Play => session.TryPlayAsync(),
            MediaAction::Pause => session.TryPauseAsync(),
            MediaAction::Next => session.TrySkipNextAsync(),
            MediaAction::Previous => session.TrySkipPreviousAsync(),
            MediaAction::Seek(seconds) => {
                let start = session
                    .GetTimelineProperties()
                    .and_then(|t| t.StartTime())
                    .map_err(failed)?
                    .Duration;
                session.TryChangePlaybackPositionAsync(start + (seconds * TICKS_PER_SECOND) as i64)
            }
        };
        operation.and_then(|o| o.get()).map_err(failed)
    }

    fn art(&self, session: &str) -> PortResult<Option<Art>> {
        let session = find(&manager()?, session)?;
        let props = session
            .TryGetMediaPropertiesAsync()
            .and_then(|o| o.get())
            .map_err(failed)?;
        let Ok(thumbnail) = props.Thumbnail() else {
            return Ok(None);
        };
        let stream = thumbnail
            .OpenReadAsync()
            .and_then(|o| o.get())
            .map_err(failed)?;
        let size = stream.Size().map_err(failed)? as u32;
        let reader = DataReader::CreateDataReader(&stream.cast::<IInputStream>().map_err(failed)?)
            .map_err(failed)?;
        reader
            .LoadAsync(size)
            .and_then(|o| o.get())
            .map_err(failed)?;
        let mut data = vec![0u8; size as usize];
        reader.ReadBytes(&mut data).map_err(failed)?;
        let mime = stream
            .ContentType()
            .ok()
            .map(|t| t.to_string())
            .filter(|t| !t.is_empty());
        Ok(Some(Art { mime, data }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Read-only against whatever this PC is playing (nothing playing is a fine answer).
    #[test]
    fn reading_the_real_media_state_works() {
        let state = WindowsMedia.state().expect("SMTC answers");
        for session in &state.sessions {
            assert!(!session.id.is_empty() && !session.app.is_empty());
            assert_eq!(session.art_key.len(), 12);
            if let (Some(duration), Some(position)) = (session.duration, session.position) {
                assert!(position >= 0.0 && position <= duration);
            }
        }
    }

    #[test]
    fn controlling_an_unknown_session_fails_clearly() {
        assert!(WindowsMedia
            .control("no-such-player", MediaAction::Pause)
            .is_err());
    }
}
