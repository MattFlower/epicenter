use log::{info, warn};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Payload emitted to the frontend on every mouse button press/release.
#[derive(Clone, Serialize)]
struct GlobalMouseEvent {
    /// Browser-compatible button number (0=Left, 1=Middle, 2=Right, 3+=extra)
    button: u8,
    /// Modifier keys held at the time of the event
    modifiers: Vec<String>,
    /// `"Pressed"` or `"Released"` – matches `ShortcutEventState`
    state: String,
}

/// Starts a background thread that listens for system-wide mouse events
/// and emits `"global-mouse-event"` Tauri events to the frontend.
///
/// On macOS, uses a native CGEventTap that only captures mouse events
/// (avoids interfering with media keys). Requires Input Monitoring permission.
///
/// On other platforms, uses rdev for cross-platform mouse event capture.
pub fn start_global_mouse_listener(app_handle: AppHandle) {
    #[cfg(target_os = "macos")]
    macos::start_listener(app_handle);

    #[cfg(not(target_os = "macos"))]
    rdev_impl::start_listener(app_handle);
}

// ── macOS: native CGEventTap (mouse-only) ──────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::os::raw::c_void;

    // CGEvent opaque types
    type CGEventTapProxy = *mut c_void;
    type CGEventRef = *mut c_void;
    type CGEventMask = u64;
    type CGEventField = u32;

    // Core Foundation opaque types
    type CFMachPortRef = *mut c_void;
    type CFRunLoopSourceRef = *mut c_void;
    type CFRunLoopRef = *mut c_void;
    type CFStringRef = *const c_void;
    type CFAllocatorRef = *const c_void;
    type CFIndex = isize;

    // CGEventType constants (CGEventTypes.h)
    const CG_EVENT_LEFT_MOUSE_DOWN: u32 = 1;
    const CG_EVENT_LEFT_MOUSE_UP: u32 = 2;
    const CG_EVENT_RIGHT_MOUSE_DOWN: u32 = 3;
    const CG_EVENT_RIGHT_MOUSE_UP: u32 = 4;
    const CG_EVENT_OTHER_MOUSE_DOWN: u32 = 25;
    const CG_EVENT_OTHER_MOUSE_UP: u32 = 26;

    // Tap-disabled sentinel values
    const CG_EVENT_TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFFFFFE;
    const CG_EVENT_TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFFFFFF;

    // CGEventField for the mouse button index
    const CG_MOUSE_EVENT_BUTTON_NUMBER: CGEventField = 3;

    // CGEventFlags modifier masks
    const CG_EVENT_FLAG_MASK_SHIFT: u64 = 0x00020000;
    const CG_EVENT_FLAG_MASK_CONTROL: u64 = 0x00040000;
    const CG_EVENT_FLAG_MASK_ALTERNATE: u64 = 0x00080000;
    const CG_EVENT_FLAG_MASK_COMMAND: u64 = 0x00100000;

    // CGEventTap configuration constants
    const CG_HID_EVENT_TAP: u32 = 0;
    const CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
    const CG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;

    type CGEventTapCallBack = extern "C" fn(
        proxy: CGEventTapProxy,
        event_type: u32,
        event: CGEventRef,
        user_info: *mut c_void,
    ) -> CGEventRef;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events_of_interest: CGEventMask,
            callback: CGEventTapCallBack,
            user_info: *mut c_void,
        ) -> CFMachPortRef;

        fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
        fn CGEventGetFlags(event: CGEventRef) -> u64;
        fn CGEventGetIntegerValueField(event: CGEventRef, field: CGEventField) -> i64;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFAllocatorDefault: CFAllocatorRef;
        static kCFRunLoopCommonModes: CFStringRef;

        fn CFMachPortCreateRunLoopSource(
            allocator: CFAllocatorRef,
            port: CFMachPortRef,
            order: CFIndex,
        ) -> CFRunLoopSourceRef;

        fn CFRunLoopGetCurrent() -> CFRunLoopRef;
        fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef);
        fn CFRunLoopRun();
    }

    fn cg_event_mask_bit(event_type: u32) -> CGEventMask {
        1u64 << event_type
    }

    /// Map a CGEvent button number to a browser-compatible button number.
    ///
    /// CGEvent numbering:  0=Left, 1=Right, 2=Middle, 3+=extra
    /// Browser numbering:  0=Left, 1=Middle, 2=Right, 3+=extra
    fn cg_button_to_browser(cg_button: u8) -> u8 {
        match cg_button {
            0 => 0,
            1 => 2,
            2 => 1,
            n => n,
        }
    }

    /// Context passed through the CGEventTap user_info pointer.
    /// Lives for the entire application lifetime (heap-allocated, never freed).
    struct TapContext {
        app_handle: AppHandle,
        tap: CFMachPortRef,
    }

    // Safety: TapContext is only accessed from the run-loop thread.
    unsafe impl Send for TapContext {}

    extern "C" fn tap_callback(
        _proxy: CGEventTapProxy,
        event_type: u32,
        event: CGEventRef,
        user_info: *mut c_void,
    ) -> CGEventRef {
        let ctx = unsafe { &*(user_info as *const TapContext) };

        // Re-enable the tap if macOS disabled it due to timeout
        if event_type == CG_EVENT_TAP_DISABLED_BY_TIMEOUT
            || event_type == CG_EVENT_TAP_DISABLED_BY_USER_INPUT
        {
            if !ctx.tap.is_null() {
                unsafe { CGEventTapEnable(ctx.tap, true) };
                info!("Re-enabled CGEventTap after system timeout");
            }
            return event;
        }

        let (button, state) = match event_type {
            CG_EVENT_LEFT_MOUSE_DOWN => (0u8, "Pressed"),
            CG_EVENT_LEFT_MOUSE_UP => (0u8, "Released"),
            CG_EVENT_RIGHT_MOUSE_DOWN => (2u8, "Pressed"),
            CG_EVENT_RIGHT_MOUSE_UP => (2u8, "Released"),
            CG_EVENT_OTHER_MOUSE_DOWN => {
                let cg_btn = unsafe {
                    CGEventGetIntegerValueField(event, CG_MOUSE_EVENT_BUTTON_NUMBER)
                } as u8;
                (cg_button_to_browser(cg_btn), "Pressed")
            }
            CG_EVENT_OTHER_MOUSE_UP => {
                let cg_btn = unsafe {
                    CGEventGetIntegerValueField(event, CG_MOUSE_EVENT_BUTTON_NUMBER)
                } as u8;
                (cg_button_to_browser(cg_btn), "Released")
            }
            _ => return event,
        };

        // Extract modifier flags directly from the mouse CGEvent
        let flags = unsafe { CGEventGetFlags(event) };
        let mut modifiers = Vec::new();
        if flags & CG_EVENT_FLAG_MASK_CONTROL != 0 {
            modifiers.push("control".to_string());
        }
        if flags & CG_EVENT_FLAG_MASK_SHIFT != 0 {
            modifiers.push("shift".to_string());
        }
        if flags & CG_EVENT_FLAG_MASK_ALTERNATE != 0 {
            modifiers.push("alt".to_string());
        }
        if flags & CG_EVENT_FLAG_MASK_COMMAND != 0 {
            modifiers.push("meta".to_string());
        }

        let payload = GlobalMouseEvent {
            button,
            modifiers,
            state: state.to_string(),
        };

        if let Err(e) = ctx.app_handle.emit("global-mouse-event", payload) {
            warn!("Failed to emit global-mouse-event: {}", e);
        }

        event
    }

    pub fn start_listener(app_handle: AppHandle) {
        std::thread::spawn(move || {
            info!("Global mouse listener starting (macOS native CGEventTap)");

            // Only capture mouse button events — no keyboard events.
            let mask = cg_event_mask_bit(CG_EVENT_LEFT_MOUSE_DOWN)
                | cg_event_mask_bit(CG_EVENT_LEFT_MOUSE_UP)
                | cg_event_mask_bit(CG_EVENT_RIGHT_MOUSE_DOWN)
                | cg_event_mask_bit(CG_EVENT_RIGHT_MOUSE_UP)
                | cg_event_mask_bit(CG_EVENT_OTHER_MOUSE_DOWN)
                | cg_event_mask_bit(CG_EVENT_OTHER_MOUSE_UP);

            // Heap-allocate context; lives for the app's entire lifetime.
            let ctx = Box::into_raw(Box::new(TapContext {
                app_handle,
                tap: std::ptr::null_mut(),
            }));

            unsafe {
                let tap = CGEventTapCreate(
                    CG_HID_EVENT_TAP,
                    CG_HEAD_INSERT_EVENT_TAP,
                    CG_EVENT_TAP_OPTION_LISTEN_ONLY,
                    mask,
                    tap_callback,
                    ctx as *mut c_void,
                );

                if tap.is_null() {
                    warn!("Failed to create CGEventTap — Input Monitoring permission required");
                    let _ = Box::from_raw(ctx);
                    return;
                }

                // Store tap ref so callback can re-enable it after timeout.
                (*ctx).tap = tap;

                let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
                let run_loop = CFRunLoopGetCurrent();
                CFRunLoopAddSource(run_loop, source, kCFRunLoopCommonModes);
                CGEventTapEnable(tap, true);

                info!("CGEventTap enabled — entering run loop");
                CFRunLoopRun();
            }
        });
    }
}

// ── Non-macOS: rdev-based listener ─────────────────────────────────

#[cfg(not(target_os = "macos"))]
mod rdev_impl {
    use super::*;
    use std::sync::Mutex;

    struct ModifierState {
        control: bool,
        shift: bool,
        alt: bool,
        meta: bool,
    }

    impl ModifierState {
        fn new() -> Self {
            Self {
                control: false,
                shift: false,
                alt: false,
                meta: false,
            }
        }

        fn to_vec(&self) -> Vec<String> {
            let mut v = Vec::new();
            if self.control {
                v.push("control".into());
            }
            if self.shift {
                v.push("shift".into());
            }
            if self.alt {
                v.push("alt".into());
            }
            if self.meta {
                v.push("meta".into());
            }
            v
        }

        fn update(&mut self, key: &rdev::Key, pressed: bool) {
            match key {
                rdev::Key::ControlLeft | rdev::Key::ControlRight => self.control = pressed,
                rdev::Key::ShiftLeft | rdev::Key::ShiftRight => self.shift = pressed,
                rdev::Key::Alt | rdev::Key::AltGr => self.alt = pressed,
                rdev::Key::MetaLeft | rdev::Key::MetaRight => self.meta = pressed,
                _ => {}
            }
        }
    }

    fn button_to_u8(button: &rdev::Button) -> u8 {
        match button {
            rdev::Button::Left => 0,
            rdev::Button::Middle => 1,
            rdev::Button::Right => 2,
            rdev::Button::Unknown(n) => *n as u8,
        }
    }

    pub fn start_listener(app_handle: AppHandle) {
        let modifier_state = Mutex::new(ModifierState::new());

        std::thread::spawn(move || {
            info!("Global mouse listener started (rdev)");

            let callback = move |event: rdev::Event| {
                match event.event_type {
                    rdev::EventType::KeyPress(key) => {
                        if let Ok(mut state) = modifier_state.lock() {
                            state.update(&key, true);
                        }
                    }
                    rdev::EventType::KeyRelease(key) => {
                        if let Ok(mut state) = modifier_state.lock() {
                            state.update(&key, false);
                        }
                    }
                    rdev::EventType::ButtonPress(button) => {
                        let modifiers = modifier_state
                            .lock()
                            .map(|s| s.to_vec())
                            .unwrap_or_default();

                        let payload = GlobalMouseEvent {
                            button: button_to_u8(&button),
                            modifiers,
                            state: "Pressed".into(),
                        };

                        if let Err(e) = app_handle.emit("global-mouse-event", payload) {
                            warn!("Failed to emit global-mouse-event: {}", e);
                        }
                    }
                    rdev::EventType::ButtonRelease(button) => {
                        let modifiers = modifier_state
                            .lock()
                            .map(|s| s.to_vec())
                            .unwrap_or_default();

                        let payload = GlobalMouseEvent {
                            button: button_to_u8(&button),
                            modifiers,
                            state: "Released".into(),
                        };

                        if let Err(e) = app_handle.emit("global-mouse-event", payload) {
                            warn!("Failed to emit global-mouse-event: {}", e);
                        }
                    }
                    _ => {}
                }
            };

            if let Err(error) = rdev::listen(callback) {
                warn!("Global mouse listener error: {:?}", error);
            }
        });
    }
}
