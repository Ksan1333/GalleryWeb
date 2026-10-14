//! COM lifetime and Media Engine creation, shared by playback and the isolated probe.
use std::sync::mpsc;
use windows::{
    Win32::{
        Media::MediaFoundation::*,
        System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
            CoUninitialize,
        },
    },
    core::implement,
};

#[implement(IMFMediaEngineNotify)]
pub(super) struct Notify(pub(super) mpsc::Sender<(u32, usize, u32)>);
impl IMFMediaEngineNotify_Impl for Notify_Impl {
    fn EventNotify(&self, event: u32, parameter: usize, result: u32) -> windows::core::Result<()> {
        let _ = self.0.send((event, parameter, result));
        Ok(())
    }
}

pub(super) struct Runtime;
impl Runtime {
    pub(super) fn start() -> windows::core::Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            if let Err(error) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                CoUninitialize();
                return Err(error);
            }
        }
        Ok(Self)
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}
pub(super) struct Engine(pub(super) IMFMediaEngine);
impl Drop for Engine {
    fn drop(&mut self) {
        unsafe {
            let _ = self.0.Shutdown();
        }
    }
}

pub(super) fn create_engine(
    hwnd: Option<usize>,
    notify: &IMFMediaEngineNotify,
) -> windows::core::Result<Engine> {
    unsafe {
        let mut attributes = None;
        MFCreateAttributes(&mut attributes, 2)?;
        let attributes = attributes.unwrap();
        attributes.SetUnknown(&MF_MEDIA_ENGINE_CALLBACK, notify)?;
        if let Some(hwnd) = hwnd {
            attributes.SetUINT64(&MF_MEDIA_ENGINE_PLAYBACK_HWND, hwnd as u64)?;
        }
        let factory: IMFMediaEngineClassFactory =
            CoCreateInstance(&CLSID_MFMediaEngineClassFactory, None, CLSCTX_INPROC_SERVER)?;
        let flags = if hwnd.is_none() {
            MF_MEDIA_ENGINE_AUDIOONLY.0 as u32
        } else {
            0
        };
        Ok(Engine(factory.CreateInstance(flags, &attributes)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    use windows::core::BSTR;

    #[test]
    fn media_foundation_headless_load_seek_and_release() {
        // Synthetic silent PCM only: no HWND, visible app, user media or audio.
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("日本語 seek.wav");
        let data_size = 48000u32 * 2 * 4;
        let mut wav = Vec::new();
        wav.extend(b"RIFF");
        wav.extend((36 + data_size).to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16u32.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(48000u32.to_le_bytes());
        wav.extend(96000u32.to_le_bytes());
        wav.extend(2u16.to_le_bytes());
        wav.extend(16u16.to_le_bytes());
        wav.extend(b"data");
        wav.extend(data_size.to_le_bytes());
        wav.resize(44 + data_size as usize, 0);
        std::fs::write(&path, &wav).unwrap();
        {
            let _runtime = Runtime::start().unwrap();
            let (tx, events) = mpsc::channel();
            let notify: IMFMediaEngineNotify = Notify(tx).into();
            let engine = create_engine(None, &notify).unwrap();
            unsafe {
                engine.0.SetMuted(true).unwrap();
                engine
                    .0
                    .SetSource(&BSTR::from(path.to_string_lossy().as_ref()))
                    .unwrap();
                engine.0.Load().unwrap();
                let deadline = Instant::now() + Duration::from_secs(15);
                while engine.0.GetReadyState() < 2 {
                    assert!(Instant::now() < deadline, "MF load timed out");
                    for (event, parameter, result) in events.try_iter() {
                        assert_ne!(
                            event, MF_MEDIA_ENGINE_EVENT_ERROR.0 as u32,
                            "MF load error: category={parameter}, HRESULT=0x{result:08X}"
                        );
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                assert!((engine.0.GetDuration() - 4.0).abs() < 0.1);
                engine.0.Play().unwrap();
                engine.0.Pause().unwrap();
                engine.0.SetCurrentTime(2.0).unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                loop {
                    assert!(Instant::now() < deadline, "MF seek timed out");
                    if events
                        .try_iter()
                        .any(|(e, _, _)| e == MF_MEDIA_ENGINE_EVENT_SEEKED.0 as u32)
                    {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                assert!((engine.0.GetCurrentTime() - 2.0).abs() < 0.1);
                assert!(engine.0.IsPaused().as_bool());
            }
        }
        assert_eq!(std::fs::read(&path).unwrap(), wav);
        std::fs::remove_file(path).expect("MF shutdown must release the source file");
    }
}
