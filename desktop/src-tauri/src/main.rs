//! Eventide for Windows: the live web app in its own window, with one addition. Google refuses to sign anyone in
//! inside an app's own web view, so signing in happens in the person's browser and the session is handed back
//! through an eventide:// link (docs/DESIGN.md §9.1):
//!
//! 1. The web view starts to open /api/auth/<provider>. Instead, the app makes a secret (the verifier), keeps it,
//!    and opens that address in the browser with the verifier's SHA-256 (the challenge) added.
//! 2. After signing in, the server gives the browser a one-time code instead of a session, and the browser opens
//!    eventide://signin?code=…
//! 3. The app sends the code and the verifier to /desktop in its web view, which swaps them for a session.
//!
//! A program that registers eventide:// too and catches the code still cannot use it without the verifier.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

/** The site the app opens. Set EVENTIDE_URL when building to point it somewhere else. */
const HOME: &str = match option_env!("EVENTIDE_URL") {
    Some(url) => url,
    None => "https://eventide.vaibhavmann-10.workers.dev",
};

/** The server only swaps a handoff code for a session when the request names the app (packages/api/src/auth.ts). */
const USER_AGENT: &str = concat!(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 ",
    "Safari/537.36 Edg/130.0.0.0 EventideDesktop/",
    env!("CARGO_PKG_VERSION")
);

const MAIN: &str = "main";

/** The verifier of the sign-in in progress, if any. A new sign-in replaces it. */
#[derive(Default)]
struct PendingSignIn(Mutex<Option<String>>);

fn home() -> Url {
    Url::parse(HOME).expect("EVENTIDE_URL is a valid URL")
}

/** 32 random bytes, base64url: the same shape the server expects for a code or a verifier. */
fn new_verifier() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the system can supply random bytes");
    URL_SAFE_NO_PAD.encode(bytes)
}

fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn is_token(text: &str) -> bool {
    text.len() == 43 && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/**
 * Decides where a navigation in the window goes. The site's own pages stay in the window; signing in goes to the
 * browser (step 1); any other link (GitHub, an email address) opens where the person would expect it to.
 */
fn on_navigation(app: &AppHandle, url: &Url) -> bool {
    let home = home();
    if url.origin() == home.origin() {
        if !matches!(url.path(), "/api/auth/github" | "/api/auth/google") {
            return true;
        }
        let verifier = new_verifier();
        let mut in_browser = url.clone();
        in_browser.query_pairs_mut().append_pair("handoff", &challenge_for(&verifier));
        *app.state::<PendingSignIn>().0.lock().unwrap() = Some(verifier);
        let _ = app.opener().open_url(in_browser.as_str(), None::<&str>);
        return false;
    }
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
    false
}

/** Step 3: eventide://signin?code=… arrived from the browser. */
fn on_link(app: &AppHandle, link: &Url) {
    if link.scheme() != "eventide" || link.host_str() != Some("signin") {
        return;
    }
    let Some(code) = link.query_pairs().find(|(key, _)| key == "code").map(|(_, value)| value.into_owned()) else {
        return;
    };
    let Some(verifier) = app.state::<PendingSignIn>().0.lock().unwrap().take() else {
        return; // not started from this app, or already used
    };
    if !is_token(&code) {
        return;
    }
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    let mut finish = home();
    finish.set_path("/desktop");
    finish.set_fragment(Some(&format!("code={code}&verifier={verifier}")));
    let _ = window.navigate(finish);
    show(app);
}

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        // First, so a second launch (which is how Windows delivers eventide:// links) reaches this one instead.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingSignIn::default())
        .setup(|app| {
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(home()))
                .title("Eventide")
                .inner_size(1100.0, 760.0)
                .min_inner_size(380.0, 560.0)
                .background_color(tauri::window::Color(2, 4, 6, 255))
                .user_agent(USER_AGENT)
                .on_navigation(move |url| on_navigation(&handle, url))
                .build()?;

            // The installer registers eventide:// too; registering here also covers a copy run without installing.
            #[cfg(any(windows, target_os = "linux"))]
            let _ = app.deep_link().register_all();

            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for link in event.urls() {
                    on_link(&handle, &link);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Eventide failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_challenge_is_base64url_sha256_of_the_verifier() {
        // The same pair the API tests use: base64url(SHA-256("abc")).
        assert_eq!(challenge_for("abc"), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    }

    #[test]
    fn verifiers_are_tokens_the_server_accepts() {
        let verifier = new_verifier();
        assert!(is_token(&verifier));
        assert_ne!(verifier, new_verifier());
    }

    #[test]
    fn only_well_formed_codes_are_passed_on() {
        assert!(is_token(&"A".repeat(43)));
        assert!(!is_token("short"));
        assert!(!is_token(&format!("{}&x=1", "A".repeat(39))));
    }
}
