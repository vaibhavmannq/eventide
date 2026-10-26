# The Android, Windows and Linux apps

Each is the live site in an app of its own, so every change ships with a normal Deploy; the apps only need a
new release when the wrappers themselves change. The site no longer offers a browser install (no web app
manifest): the apps are the one way to install it. Apple's platforms are out of scope (they need a paid
developer account); there the site works in Safari.

| | What it is | Where |
|---|---|---|
| Android | A Trusted Web Activity: the site full screen in the phone's Chrome, with Chrome's sign-in and offline copy | `android/` |
| Windows | Tauri: the site in a WebView2 window; signing in goes through the browser (DESIGN §9.1) | `desktop/` |
| Linux | The same Tauri app, on WebKitGTK: a `.deb` and an AppImage | `desktop/` |

Releases are built by `.github/workflows/apps.yml` and published on the repository's Releases page, which the
site links to. Pull requests that touch the apps build them all, unsigned, and open the Android app on an
emulator (`.github/scripts/android-smoke.sh`): a crash on start fails the check, with the crash log as an
annotation on the run.

## One-time setup: the Android signing key

Android only installs an update over an app signed with the same key, so the key is made once and kept. It never
goes into the repository or a chat: only into GitHub's secrets and a backup of your own.

On your computer (Windows PowerShell shown; needs a JDK: `winget install EclipseAdoptium.Temurin.21.JDK`, then
open a new PowerShell):

```powershell
keytool -genkeypair -v -keystore eventide.keystore -storetype PKCS12 -alias eventide `
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Eventide"
```

Choose a long password when asked. Then:

1. **Back it up.** Put `eventide.keystore` and its password in your password manager. Lose them and people would
   have to uninstall the app to get updates.
2. **GitHub → eventide → Settings → Secrets and variables → Actions → New repository secret:**
   - `ANDROID_KEYSTORE_PASSWORD`: the password.
   - `ANDROID_KEYSTORE_BASE64`: the file as text. Copy it with
     `[Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\eventide.keystore")) | Set-Clipboard`
     and paste.
3. **The fingerprint** (public, safe to share): `keytool -list -v -keystore eventide.keystore -alias eventide`
   prints a line `SHA256: AB:CD:…`. Put that value in `packages/api/wrangler.jsonc` as `ANDROID_CERT_SHA256` and
   deploy. The site then serves `/.well-known/assetlinks.json`, and the app opens with no address bar. Until then it
   works, with a small address bar at the top.

## Making a release

Actions → **Apps** → Run workflow, on `main`, with a version like `0.1.0` (higher each time). About 15 minutes later
the release `v0.1.0` has `Eventide-android.apk` and `Eventide-windows-setup.exe`.

- **Android:** open the APK on the phone; allow installing from the browser or files app when asked.
- **Windows:** the installer is not signed with a paid certificate, so SmartScreen may warn: More info → Run anyway.
  It installs for the current user only (no administrator needed) and registers `eventide://` for signing in.
- **Linux:** `sudo apt install ./Eventide-linux-amd64.deb` on Ubuntu, Debian or Mint (it uses the system's
  WebKitGTK, so it is small). Elsewhere, `chmod +x Eventide-linux-x86_64.AppImage` and run it (it carries its own).
