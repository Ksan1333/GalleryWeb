//! A clipped child-window surface, never a top-level or always-on-top player.
//! Its independent message loop owns both HWNDs until VLC has released them.
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, mpsc};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Layout {
    pub rect: Rect,
    pub holes: Vec<Rect>,
    pub visible: bool,
}
impl Layout {
    pub fn validate(&self) -> Result<(), String> {
        let valid = |r: &Rect| {
            r.x.abs_diff(0) <= 65536
                && r.y.abs_diff(0) <= 65536
                && (0..=32768).contains(&r.width)
                && (0..=32768).contains(&r.height)
        };
        if !valid(&self.rect) || self.holes.len() > 64 || self.holes.iter().any(|r| !valid(r)) {
            return Err("動画表示領域が不正です。".into());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub kind: &'static str,
    pub x: i32,
    pub y: i32,
    pub delta: i32,
    pub buttons: u16,
}
type Emit = Arc<dyn Fn(Input) + Send + Sync>;

pub struct Surface {
    pub video: usize,
    input: usize,
    pending: Arc<Mutex<Option<Layout>>>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}
impl Surface {
    pub fn new(parent: usize, emit: Emit) -> Result<Self, String> {
        #[cfg(windows)]
        {
            windows::create(parent, emit)
        }
        #[cfg(not(windows))]
        {
            let _ = (parent, emit);
            Err("Windows専用の動画表示です。".into())
        }
    }
    pub fn update(&self, layout: Layout) -> Result<(), String> {
        layout.validate()?;
        let live = self.thread.lock().map_err(|e| e.to_string())?;
        if live.is_none() {
            return Err("動画表示は終了しています。".into());
        }
        *self.pending.lock().map_err(|e| e.to_string())? = Some(layout);
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW(
                self.input as _,
                windows::UPDATE,
                0,
                0,
            );
        }
        Ok(())
    }
    pub fn close(&self) {
        if let Some(thread) = self.thread.lock().ok().and_then(|mut t| t.take()) {
            #[cfg(windows)]
            unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW(
                    self.input as _,
                    windows_sys::Win32::UI::WindowsAndMessaging::WM_CLOSE,
                    0,
                    0,
                );
            }
            let _ = thread.join();
        }
    }
}
impl Drop for Surface {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        ptr,
        time::Instant,
    };
    use windows_sys::Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        System::LibraryLoader::GetModuleHandleW,
        UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    };
    pub const UPDATE: u32 = WM_APP + 71;
    struct Context {
        video: HWND,
        parent: HWND,
        emit: Emit,
        pending: Arc<Mutex<Option<Layout>>>,
        rect: Cell<Rect>,
        updated: Cell<Instant>,
        pressed: Cell<bool>,
        layout: RefCell<Option<Layout>>,
    }
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    unsafe fn region(hwnd: HWND, layout: &Layout) -> bool {
        unsafe {
            let r = CreateRectRgn(0, 0, layout.rect.width, layout.rect.height);
            if r.is_null() {
                return false;
            }
            for hole in &layout.holes {
                let cut = CreateRectRgn(hole.x, hole.y, hole.x + hole.width, hole.y + hole.height);
                if cut.is_null() {
                    DeleteObject(r);
                    return false;
                }
                let result = CombineRgn(r, r, cut, RGN_DIFF);
                DeleteObject(cut);
                if result == 0 {
                    DeleteObject(r);
                    return false;
                }
            }
            // On success Windows owns the region, including destruction.
            if SetWindowRgn(hwnd, r, 1) == 0 {
                DeleteObject(r);
                return false;
            }
            true
        }
    }
    unsafe extern "system" fn input_proc(
        hwnd: HWND,
        message: u32,
        w: WPARAM,
        l: LPARAM,
    ) -> LRESULT {
        unsafe {
            let data = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Context;
            if message == WM_NCCREATE {
                SetWindowLongPtrW(
                    hwnd,
                    GWLP_USERDATA,
                    (*(l as *const CREATESTRUCTW)).lpCreateParams as isize,
                );
                return DefWindowProcW(hwnd, message, w, l);
            }
            if data.is_null() {
                return DefWindowProcW(hwnd, message, w, l);
            }
            // Window APIs can reenter this procedure. Interior mutability keeps
            // us from holding an exclusive reference across SendMessage paths.
            let context = &*data;
            match message {
                UPDATE => {
                    let next = context.pending.lock().ok().and_then(|mut p| p.take());
                    if let Some(layout) = next {
                        context.updated.set(Instant::now());
                        if context.layout.borrow().as_ref() == Some(&layout) {
                            return 0;
                        }
                        context.layout.replace(Some(layout.clone()));
                        context.rect.set(layout.rect);
                        if !layout.visible || layout.rect.width == 0 || layout.rect.height == 0 {
                            if GetCapture() == hwnd {
                                ReleaseCapture();
                            }
                            ShowWindow(hwnd, SW_HIDE);
                            ShowWindow(context.video, SW_HIDE);
                        } else {
                            for child in [context.video, hwnd] {
                                if !region(child, &layout) {
                                    ShowWindow(hwnd, SW_HIDE);
                                    ShowWindow(context.video, SW_HIDE);
                                    return 0;
                                }
                                SetWindowPos(
                                    child,
                                    HWND_TOP,
                                    layout.rect.x,
                                    layout.rect.y,
                                    layout.rect.width,
                                    layout.rect.height,
                                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                                );
                            }
                        }
                    }
                    0
                }
                WM_TIMER => {
                    // A renderer crash/unmount must not leave an orphan overlay.
                    if context.updated.get().elapsed().as_secs() >= 3 {
                        context.layout.replace(None);
                        if GetCapture() == hwnd {
                            ReleaseCapture();
                        }
                        ShowWindow(hwnd, SW_HIDE);
                        ShowWindow(context.video, SW_HIDE);
                    }
                    0
                }
                // A real user click may activate the app; programmatic layout
                // still uses NOACTIVATE and never steals the foreground.
                WM_MOUSEACTIVATE => MA_ACTIVATE as _,
                WM_SETCURSOR => {
                    SetCursor(LoadCursorW(ptr::null_mut(), IDC_ARROW));
                    1
                }
                WM_LBUTTONDOWN | WM_LBUTTONUP | WM_MOUSEMOVE | WM_MOUSEWHEEL
                | WM_CAPTURECHANGED => {
                    if message == WM_CAPTURECHANGED && !context.pressed.replace(false) {
                        return 0;
                    }
                    if message == WM_LBUTTONUP {
                        context.pressed.set(false);
                    }
                    let mut point = POINT {
                        x: l as i16 as i32,
                        y: (l >> 16) as i16 as i32,
                    };
                    if message == WM_MOUSEWHEEL {
                        ScreenToClient(context.parent, &mut point);
                    } else {
                        point.x += context.rect.get().x;
                        point.y += context.rect.get().y;
                    }
                    let kind = match message {
                        WM_LBUTTONDOWN => "pointerdown",
                        WM_LBUTTONUP => "pointerup",
                        WM_MOUSEWHEEL => "wheel",
                        WM_CAPTURECHANGED => "pointercancel",
                        _ => "pointermove",
                    };
                    if message == WM_LBUTTONDOWN {
                        context.pressed.set(true);
                        SetCapture(hwnd);
                    }
                    (context.emit)(Input {
                        kind,
                        x: point.x,
                        y: point.y,
                        delta: if message == WM_MOUSEWHEEL {
                            -((w >> 16) as i16 as i32)
                        } else {
                            0
                        },
                        buttons: if message == WM_LBUTTONUP {
                            0
                        } else {
                            (w & 1) as u16
                        },
                    });
                    if message == WM_LBUTTONUP && GetCapture() == hwnd {
                        ReleaseCapture();
                    }
                    0
                }
                WM_CLOSE => {
                    if GetCapture() == hwnd {
                        ReleaseCapture();
                    }
                    DestroyWindow(hwnd);
                    0
                }
                WM_DESTROY => {
                    PostQuitMessage(0);
                    0
                }
                _ => DefWindowProcW(hwnd, message, w, l),
            }
        }
    }
    pub fn create(parent: usize, emit: Emit) -> Result<Surface, String> {
        let pending = Arc::new(Mutex::new(None));
        let thread_pending = pending.clone();
        let (send, receive) = mpsc::sync_channel(1);
        let thread = std::thread::spawn(move || unsafe {
            let instance = GetModuleHandleW(ptr::null());
            let class = wide("PixVaultVlcInput");
            let video_class = wide("PixVaultVlcVideo");
            let video_wc = WNDCLASSW {
                style: CS_OWNDC,
                lpfnWndProc: Some(DefWindowProcW),
                hInstance: instance,
                hCursor: LoadCursorW(ptr::null_mut(), IDC_ARROW),
                hbrBackground: GetStockObject(BLACK_BRUSH) as _,
                lpszClassName: video_class.as_ptr(),
                ..std::mem::zeroed()
            };
            RegisterClassW(&video_wc);
            let wc = WNDCLASSW {
                lpfnWndProc: Some(input_proc),
                hInstance: instance,
                hCursor: LoadCursorW(ptr::null_mut(), IDC_ARROW),
                hbrBackground: GetStockObject(BLACK_BRUSH) as _,
                lpszClassName: class.as_ptr(),
                ..std::mem::zeroed()
            };
            RegisterClassW(&wc);
            // Parent 0 is reserved for isolated hidden tests: never show it.
            let owned_parent = if parent == 0 {
                CreateWindowExW(
                    0,
                    wide("STATIC").as_ptr(),
                    wide("PixVault hidden GPU probe").as_ptr(),
                    WS_OVERLAPPEDWINDOW,
                    0,
                    0,
                    1280,
                    720,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    instance,
                    ptr::null(),
                )
            } else {
                ptr::null_mut()
            };
            let parent = if parent == 0 {
                owned_parent
            } else {
                parent as HWND
            };
            let parent_error = if parent.is_null() { GetLastError() } else { 0 };
            let video = CreateWindowExW(
                WS_EX_NOACTIVATE,
                video_class.as_ptr(),
                ptr::null(),
                WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                0,
                0,
                1280,
                720,
                parent,
                ptr::null_mut(),
                instance,
                ptr::null(),
            );
            let video_error = if video.is_null() { GetLastError() } else { 0 };
            let mut context = Box::new(Context {
                video,
                parent,
                emit,
                pending: thread_pending,
                rect: Cell::new(Rect::default()),
                updated: Cell::new(Instant::now()),
                pressed: Cell::new(false),
                layout: RefCell::new(None),
            });
            let input = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_NOACTIVATE,
                class.as_ptr(),
                ptr::null(),
                WS_CHILD | WS_CLIPSIBLINGS,
                0,
                0,
                1280,
                720,
                parent,
                ptr::null_mut(),
                instance,
                &mut *context as *mut Context as _,
            );
            if video.is_null() || input.is_null() || parent.is_null() {
                let _ = send.send(Err(format!("動画表示用ウィンドウを作成できません (parent={parent_error}, video={video_error}, input={}).", if input.is_null() { GetLastError() } else { 0 })));
            } else {
                // Alpha 0 would lose hit-testing. 1/255 keeps input above VLC
                // without a full-screen overlay; DOM controls are cut out.
                SetLayeredWindowAttributes(input, 0, 1, LWA_ALPHA);
                SetTimer(input, 1, 500, None);
                if send.send(Ok((video as usize, input as usize))).is_ok() {
                    let mut message = std::mem::zeroed();
                    while GetMessageW(&mut message, ptr::null_mut(), 0, 0) > 0 {
                        TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
            }
            if IsWindow(input) != 0 {
                DestroyWindow(input);
            }
            if IsWindow(video) != 0 {
                DestroyWindow(video);
            }
            if !owned_parent.is_null() {
                DestroyWindow(owned_parent);
            }
        });
        match receive.recv().map_err(|e| e.to_string())? {
            Ok((video, input)) => Ok(Surface {
                video,
                input,
                pending,
                thread: Mutex::new(Some(thread)),
            }),
            Err(error) => {
                let _ = thread.join();
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unbounded_native_regions() {
        assert!(
            Layout {
                holes: vec![Rect::default(); 65],
                ..Layout::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            Layout {
                rect: Rect {
                    x: i32::MIN,
                    ..Rect::default()
                },
                ..Layout::default()
            }
            .validate()
            .is_err()
        );
    }
    #[cfg(windows)]
    #[test]
    fn hidden_child_lifecycle_and_layout() {
        let surface = Surface::new(0, Arc::new(|_| {})).unwrap();
        surface
            .update(Layout {
                rect: Rect {
                    width: 640,
                    height: 360,
                    ..Rect::default()
                },
                visible: true,
                holes: vec![Rect {
                    x: 100,
                    y: 100,
                    width: 80,
                    height: 60,
                }],
            })
            .unwrap();
        unsafe {
            use windows_sys::Win32::{Graphics::Gdi::*, UI::WindowsAndMessaging::*};
            SendMessageW(surface.input as _, windows::UPDATE, 0, 0);
            for child in [surface.video, surface.input] {
                let region = CreateRectRgn(0, 0, 0, 0);
                assert_ne!(GetWindowRgn(child as _, region), 0);
                assert_ne!(PtInRegion(region, 10, 10), 0);
                assert_eq!(
                    PtInRegion(region, 120, 120),
                    0,
                    "DOM controls remain outside the native region"
                );
                DeleteObject(region);
                assert_eq!(
                    IsWindowVisible(child as _),
                    0,
                    "test parent must remain hidden"
                );
            }
        }
        surface.update(Layout::default()).unwrap();
        surface.close();
        surface.close();
    }
}
