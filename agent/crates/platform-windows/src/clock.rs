//! The PC's clock in the person's time zone, for the time windows of the automation rules.
use ssd_core::ports::ClockPort;
use windows::Win32::System::SystemInformation::GetLocalTime;

#[derive(Default)]
pub struct WindowsClock;

impl ClockPort for WindowsClock {
    fn minute_of_day(&self) -> u16 {
        let now = unsafe { GetLocalTime() };
        now.wHour * 60 + now.wMinute
    }
}
