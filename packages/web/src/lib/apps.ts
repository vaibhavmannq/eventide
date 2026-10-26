/** Where the Android APK, the Windows installer and the Linux builds are published (.github/workflows/apps.yml). */
export const DOWNLOADS = 'https://github.com/vaibhavmannq/eventide/releases/latest';

/**
 * True inside one of the apps, which name themselves in their user agent (desktop/src-tauri/src/main.rs,
 * android/…/MainActivity.java), or a home-screen copy of the site. There, a link to the apps is noise.
 */
export const inApp =
  matchMedia('(display-mode: standalone)').matches || /\bEventide(Desktop|Android)\//.test(navigator.userAgent);
