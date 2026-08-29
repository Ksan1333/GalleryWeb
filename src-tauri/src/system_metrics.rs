use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CpuTimes {
    idle: u64,
    kernel: u64,
    user: u64,
}

#[derive(Default)]
pub struct SystemMetricsState {
    previous_cpu: Mutex<Option<CpuTimes>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemLoadSample {
    pub timestamp_ms: i64,
    pub cpu_percent: Option<f32>,
    pub memory_percent: f32,
    pub used_memory_bytes: u64,
    pub total_memory_bytes: u64,
}

fn cpu_percent(previous: CpuTimes, current: CpuTimes) -> Option<f32> {
    let idle = current.idle.checked_sub(previous.idle)?;
    let kernel = current.kernel.checked_sub(previous.kernel)?;
    let user = current.user.checked_sub(previous.user)?;
    let total = kernel.checked_add(user)?;
    if total == 0 {
        return None;
    }
    let busy = total.saturating_sub(idle);
    Some((busy as f64 * 100.0 / total as f64).clamp(0.0, 100.0) as f32)
}

#[cfg(windows)]
fn filetime_value(value: windows_sys::Win32::Foundation::FILETIME) -> u64 {
    (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
}

#[cfg(windows)]
fn read_system_load(state: &SystemMetricsState) -> Result<SystemLoadSample, String> {
    use std::{mem::MaybeUninit, mem::size_of};

    use windows_sys::Win32::{
        Foundation::FILETIME,
        System::{
            SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX},
            Threading::GetSystemTimes,
        },
    };

    // These Windows structures are plain-old-data. Zero initialization is the
    // documented setup for MEMORYSTATUSEX, followed by setting dwLength.
    let empty_time = || FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut idle = empty_time();
    let mut kernel = empty_time();
    let mut user = empty_time();
    let times_ok = unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) };
    if times_ok == 0 {
        return Err("CPU使用率を取得できませんでした".to_owned());
    }
    let current = CpuTimes {
        idle: filetime_value(idle),
        kernel: filetime_value(kernel),
        user: filetime_value(user),
    };
    let cpu_percent = {
        let mut previous = state
            .previous_cpu
            .lock()
            .map_err(|_| "CPU使用率の計測状態を取得できませんでした".to_owned())?;
        let percent = previous.and_then(|previous| cpu_percent(previous, current));
        *previous = Some(current);
        percent
    };

    let mut memory = unsafe { MaybeUninit::<MEMORYSTATUSEX>::zeroed().assume_init() };
    memory.dwLength = size_of::<MEMORYSTATUSEX>() as u32;
    let memory_ok = unsafe { GlobalMemoryStatusEx(&mut memory) };
    if memory_ok == 0 || memory.ullTotalPhys == 0 {
        return Err("メモリ使用率を取得できませんでした".to_owned());
    }
    let used_memory_bytes = memory.ullTotalPhys.saturating_sub(memory.ullAvailPhys);
    let memory_percent =
        (used_memory_bytes as f64 * 100.0 / memory.ullTotalPhys as f64).clamp(0.0, 100.0) as f32;

    Ok(SystemLoadSample {
        timestamp_ms: crate::catalog::now_millis(),
        cpu_percent,
        memory_percent,
        used_memory_bytes,
        total_memory_bytes: memory.ullTotalPhys,
    })
}

#[cfg(not(windows))]
fn read_system_load(_state: &SystemMetricsState) -> Result<SystemLoadSample, String> {
    Err("システム負荷の取得はWindows版でのみ利用できます".to_owned())
}

/// Returns one instantaneous sample. No background worker is retained: the
/// frontend polls this command only while the expanded AI monitor is visible,
/// so sampling stops automatically when the panel is minimized or closed.
#[tauri::command]
pub fn sample_system_load(
    state: State<'_, SystemMetricsState>,
) -> Result<SystemLoadSample, String> {
    read_system_load(&state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calculates_cpu_busy_percentage_from_windows_counters() {
        let previous = CpuTimes {
            idle: 100,
            kernel: 400,
            user: 200,
        };
        let current = CpuTimes {
            idle: 130,
            kernel: 470,
            user: 230,
        };
        // Kernel includes idle: total delta is 100 and busy delta is 70.
        assert_eq!(cpu_percent(previous, current), Some(70.0));
    }

    #[test]
    fn rejects_non_monotonic_or_empty_cpu_samples() {
        let sample = CpuTimes {
            idle: 100,
            kernel: 200,
            user: 300,
        };
        assert_eq!(cpu_percent(sample, sample), None);
        assert_eq!(cpu_percent(sample, CpuTimes { idle: 99, ..sample }), None);
    }

    #[cfg(windows)]
    #[test]
    fn reads_live_windows_memory_counters() {
        let state = SystemMetricsState::default();
        let sample = read_system_load(&state).expect("Windows system load sample");
        assert!(sample.total_memory_bytes > 0);
        assert!(sample.used_memory_bytes <= sample.total_memory_bytes);
        assert!((0.0..=100.0).contains(&sample.memory_percent));

        let next = read_system_load(&state).expect("second Windows system load sample");
        if let Some(cpu) = next.cpu_percent {
            assert!((0.0..=100.0).contains(&cpu));
        }
    }
}
