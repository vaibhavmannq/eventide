#!/bin/sh
# Opens the Android app on an emulator and reports what happened, as annotations on the run (apps.yml).
# Fails if the app crashed, is not in front 20 seconds later, or is not showing the site's sign-in screen.
set -u
annotate() { # level, title, text
  printf '::%s title=%s::%s\n' "$1" "$2" "$(printf '%s' "$3" | sed ':a;N;$!ba;s/%/%25/g;s/\r//g;s/\n/%0A/g')"
}

adb install -r android/app/build/outputs/apk/debug/app-debug.apk || exit 1
adb logcat -c
adb shell am start -W -n io.github.vaibhavmannq.eventide/.MainActivity
sleep 30
adb logcat -d > logcat.txt
adb exec-out screencap -p > android-screen.png
top=$(adb shell dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity" | head -3)
annotate notice "In front after 30 s" "$top"
annotate notice "Page console" "$(grep -E 'chromium.*CONSOLE|cr_.*(Error|error)' logcat.txt | tail -20)."

crash=$(grep -A 30 "FATAL EXCEPTION" logcat.txt | head -45)
if [ -n "$crash" ]; then
  annotate error "The app crashed" "$crash"
  exit 1
fi
if ! printf '%s' "$top" | grep -q "io.github.vaibhavmannq.eventide"; then
  annotate error "The app is not in front" "$top"
  exit 1
fi
# The site, inside the app's own window: ask the page itself (DevTools, which debug builds allow) what it shows.
pid=$(adb shell pidof io.github.vaibhavmannq.eventide | tr -d '\r')
adb forward tcp:9222 "localabstract:webview_devtools_remote_$pid" >/dev/null
page=$(node -e '
  (async () => {
    const [target] = await (await fetch("http://127.0.0.1:9222/json")).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok) => (ws.onopen = ok));
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "location.href + \"\\n\" + document.body.innerText" } }));
    ws.onmessage = (m) => { console.log(JSON.parse(m.data).result.result.value); ws.close(); };
  })().catch((e) => console.log("DevTools unreachable: " + e));
')
if ! printf '%s' "$page" | grep -q "Sign in with"; then
  annotate error "The app is open but the site is not showing" "$page"
  exit 1
fi
annotate notice "Showing the site" "$(printf '%s' "$page" | head -8)"

# The page starts below the status bar: the WebView's top edge (left,top-right,bottom in its frame) is not 0.
view=$(adb shell dumpsys activity top | grep -m1 "android.webkit.WebView{")
top_edge=$(printf '%s' "$view" | grep -oE '[0-9]+,[0-9]+-[0-9]+,[0-9]+' | head -1 | cut -d, -f2 | cut -d- -f1)
annotate notice "WebView bounds" "$view"
if [ "${top_edge:-0}" -le 0 ]; then
  annotate error "The page runs under the status bar" "$view"
  exit 1
fi
