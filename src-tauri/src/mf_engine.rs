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
        } else {
            // Headless test path: decoded video stays in frame-server mode.
            // No HWND, audio endpoint or visible desktop is required.
            attributes.SetUINT32(&MF_MEDIA_ENGINE_VIDEO_OUTPUT_FORMAT, 87)?; // DXGI_FORMAT_B8G8R8A8_UNORM
        }
        let factory: IMFMediaEngineClassFactory =
            CoCreateInstance(&CLSID_MFMediaEngineClassFactory, None, CLSCTX_INPROC_SERVER)?;
        Ok(Engine(factory.CreateInstance(0, &attributes)?))
    }
}

#[cfg(test)]
#[path = "test_video_fixture.rs"]
mod test_fixture;

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    use windows::{
        Win32::{
            Foundation::{RECT, S_OK},
            Graphics::Imaging::*,
        },
        core::{BSTR, Interface},
    };

    unsafe fn receive_frame(media: &IMFMediaEngine, bitmap: &IWICBitmap) -> bool {
        unsafe {
            let mut timestamp = 0;
            // The generated Result<i64> binding erases S_FALSE. Keep it here
            // so an empty tick never attempts to copy a nonexistent frame.
            let status = (media.vtable().OnVideoStreamTick)(media.as_raw(), &mut timestamp);
            status.ok().unwrap();
            if status != S_OK {
                return false;
            }
            media
                .TransferVideoFrame(
                    bitmap,
                    None,
                    &RECT {
                        left: 0,
                        top: 0,
                        right: 64,
                        bottom: 48,
                    },
                    None,
                )
                .unwrap();
            true
        }
    }

    #[test]
    fn media_foundation_headless_load_seek_and_release() {
        // Synthetic video without an audio track: the CI runner has no audio sink.
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("日本語 seek.mp4");
        test_fixture::create_h264_mp4(&path);
        let original = std::fs::read(&path).unwrap();
        {
            let _runtime = Runtime::start().unwrap();
            let (tx, events) = mpsc::channel();
            let notify: IMFMediaEngineNotify = Notify(tx).into();
            let engine = create_engine(None, &notify).unwrap();
            unsafe {
                let factory: IWICImagingFactory =
                    CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).unwrap();
                let bitmap = factory
                    .CreateBitmap(64, 48, &GUID_WICPixelFormat32bppBGRA, WICBitmapCacheOnLoad)
                    .unwrap();
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
                assert!((engine.0.GetDuration() - 0.3).abs() < 0.01);
                let (mut width, mut height) = (0, 0);
                engine
                    .0
                    .GetNativeVideoSize(Some(&mut width), Some(&mut height))
                    .unwrap();
                assert_eq!((width, height), (64, 48));
                let mut frames = usize::from(receive_frame(&engine.0, &bitmap));
                engine.0.Play().unwrap();
                engine.0.Pause().unwrap();
                engine.0.SetCurrentTime(0.1).unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                loop {
                    assert!(
                        Instant::now() < deadline,
                        "MF seek timed out: time={}, seeking={}, ready={}, frames={frames}",
                        engine.0.GetCurrentTime(),
                        engine.0.IsSeeking().as_bool(),
                        engine.0.GetReadyState()
                    );
                    frames += usize::from(receive_frame(&engine.0, &bitmap));
                    let mut seeked = false;
                    for (event, parameter, result) in events.try_iter() {
                        assert_ne!(
                            event, MF_MEDIA_ENGINE_EVENT_ERROR.0 as u32,
                            "MF seek error: category={parameter}, HRESULT=0x{result:08X}"
                        );
                        seeked |= event == MF_MEDIA_ENGINE_EVENT_SEEKED.0 as u32;
                    }
                    if seeked {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                assert!((engine.0.GetCurrentTime() - 0.1).abs() < 0.05);
                assert!(engine.0.IsPaused().as_bool());
                assert!(frames > 0, "MF must produce a decoded video frame");
            }
        }
        assert_eq!(std::fs::read(&path).unwrap(), original);
        std::fs::remove_file(path).expect("MF shutdown must release the source file");
    }
}
