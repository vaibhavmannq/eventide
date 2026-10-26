/** Where the Android APK, the Windows installer and the Linux builds are published (.github/workflows/apps.yml). */
export const DOWNLOADS = 'https://github.com/vaibhavmannq/eventide/releases/latest';

/**
 * True inside one of the apps: the Android app shows the site full screen (display-mode standalone), and the
 * desktop app names itself in its user agent (desktop/src-tauri/src/main.rs). There, a link to the apps is noise.
 */
export const inApp =
  matchMedia('(display-mode: standalone)').matches || /\bEventideDesktop\//.test(navigator.userAgent);
