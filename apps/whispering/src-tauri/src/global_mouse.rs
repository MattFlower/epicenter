use log::{info, warn};
use serde::Serialize;
use std::sync::Mutex;
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

/// Tracks which modifier keys are currently held down.
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

/// Map an rdev Button to a browser-compatible button number.
fn button_to_u8(button: &rdev::Button) -> u8 {
    match button {
        rdev::Button::Left => 0,
        rdev::Button::Middle => 1,
        rdev::Button::Right => 2,
        rdev::Button::Unknown(n) => *n as u8,
    }
}

/// Starts a background thread that listens for system-wide mouse events via rdev
/// and emits `"global-mouse-event"` Tauri events to the frontend.
///
/// This listener runs for the entire lifetime of the application.
/// On macOS it requires the Input Monitoring permission.
pub fn start_global_mouse_listener(app_handle: AppHandle) {
    let modifier_state = Mutex::new(ModifierState::new());

    std::thread::spawn(move || {
        info!("Global mouse listener started");

        let callback = move |event: rdev::Event| {
            match event.event_type {
                // Track modifier key state
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

                // Emit mouse button events
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

                // Ignore mouse move / scroll events
                _ => {}
            }
        };

        if let Err(error) = rdev::listen(callback) {
            warn!("Global mouse listener error: {:?}", error);
        }
    });
}
