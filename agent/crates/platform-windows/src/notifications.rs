//! The Windows notification listener for the `NotificationsPort`: the same list as the Action Center, which also receives what Do Not Disturb or
//! a game kept from popping up. Typed WinRT (no `dynamic` or reflection), same answers as the C# and PowerShell helpers.
use serde_json::{json, Value};
use ssd_core::ports::{NotificationsPort, PortError, PortResult};
use windows::UI::Notifications::Management::{
    UserNotificationListener, UserNotificationListenerAccessStatus,
};
use windows::UI::Notifications::NotificationKinds;

use crate::audio::com;

/// Ticks (100 ns) between 1601-01-01, where WinRT dates start, and 1970-01-01.
const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;

fn failed(error: windows::core::Error) -> PortError {
    PortError::Failed(error.message())
}

#[derive(Default)]
pub struct WindowsNotifications;

impl NotificationsPort for WindowsNotifications {
    /// `{ access, notifications: [{ id, aumid, app, title, body, time }] }`, newest last.
    fn list(&self) -> PortResult<Value> {
        com();
        let listener = UserNotificationListener::Current().map_err(failed)?;
        let mut access = listener.GetAccessStatus().map_err(failed)?;
        if access != UserNotificationListenerAccessStatus::Allowed {
            access = listener
                .RequestAccessAsync()
                .and_then(|operation| operation.get())
                .map_err(failed)?;
        }
        let name = if access == UserNotificationListenerAccessStatus::Allowed {
            "allowed"
        } else if access == UserNotificationListenerAccessStatus::Denied {
            "denied"
        } else {
            "unspecified"
        };
        let mut notifications: Vec<(i64, Value)> = Vec::new();
        if access == UserNotificationListenerAccessStatus::Allowed {
            let items = listener
                .GetNotificationsAsync(NotificationKinds::Toast)
                .and_then(|operation| operation.get())
                .map_err(failed)?;
            for item in items {
                let time = (item.CreationTime().map_err(failed)?.UniversalTime - UNIX_EPOCH_TICKS)
                    / 10_000;
                let mut texts: Vec<String> = Vec::new();
                if let Ok(bindings) = item
                    .Notification()
                    .and_then(|n| n.Visual())
                    .and_then(|v| v.Bindings())
                {
                    for binding in bindings {
                        if let Ok(elements) = binding.GetTextElements() {
                            texts.extend(
                                elements
                                    .into_iter()
                                    .filter_map(|element| element.Text().ok())
                                    .map(|t| t.to_string())
                                    .filter(|t| !t.is_empty()),
                            );
                        }
                    }
                }
                let app = item.AppInfo().ok();
                let aumid = app
                    .as_ref()
                    .and_then(|a| a.AppUserModelId().ok())
                    .map(|h| h.to_string())
                    .unwrap_or_default();
                let display = app
                    .as_ref()
                    .and_then(|a| a.DisplayInfo().ok())
                    .and_then(|d| d.DisplayName().ok())
                    .map(|h| h.to_string());
                notifications.push((
                    time,
                    json!({
                        "id": item.Id().map_err(failed)?, "aumid": aumid, "app": display,
                        "title": texts.first().cloned().unwrap_or_default(), "body": texts.iter().skip(1).cloned().collect::<Vec<_>>().join("\n"), "time": time,
                    }),
                ));
            }
        }
        notifications.sort_by_key(|(time, _)| *time);
        Ok(
            json!({ "access": name, "notifications": notifications.into_iter().map(|(_, n)| n).collect::<Vec<_>>() }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The crash this guards against (agent 0.1.3, 17:59:46): the API reads from a pool of blocking threads that Tokio lets go when they are idle.
    /// When the last thread that had started COM is gone the process's multithreaded apartment is torn down, and the WinRT factory that was
    /// cached on the first call pointed into it: the next call, from a new thread, jumped through a dead pointer (access violation).
    /// Reading from one thread, letting it end, and reading from another has to work.
    #[test]
    fn a_read_from_a_new_thread_after_the_first_one_ended_works() {
        for _ in 0..3 {
            std::thread::spawn(|| WindowsNotifications.list().map(|_| ()))
                .join()
                .expect("the thread did not crash")
                .expect("the listener answers");
            // give Windows time to tear the apartment down, as the idle pool does
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
    }

    /// Read-only: lists what the Action Center holds on this PC (nothing, or "denied", are fine answers).
    #[test]
    fn the_real_notification_list_reads() {
        let answer = WindowsNotifications.list().expect("the listener answers");
        assert!(["allowed", "denied", "unspecified"].contains(&answer["access"].as_str().unwrap()));
        for item in answer["notifications"].as_array().unwrap() {
            assert!(item["id"].as_u64().is_some() && item["time"].as_i64().unwrap() > 0);
        }
    }
}
