#!/bin/sh
# Opens the Android app on an emulator and reports what happened, as annotations on the run (apps.yml).
# Fails if the app crashed, or if neither the app nor a browser hosting it is in front 20 seconds later.
set -u
annotate() { # level, title, text
  printf '::%s title=%s::%s\n' "$1" "$2" "$(printf '%s' "$3" | sed ':a;N;$!ba;s/%/%25/g;s/\r//g;s/\n/%0A/g')"
}

adb install -r android/app/build/outputs/apk/debug/app-debug.apk || exit 1
adb logcat -c
adb shell am start -W -n io.github.vaibhavmannq.eventide/com.google.androidbrowserhelper.trusted.LauncherActivity
sleep 20
adb logcat -d > logcat.txt
adb exec-out screencap -p > android-screen.png
top=$(adb shell dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity" | head -3)
annotate notice "In front after 20 s" "$top"
annotate notice "App and browser log" "$(grep -iE 'TwaLauncher|LauncherActivity|TrustedWebActivity|CustomTabs|eventide|ActivityTaskManager: (START|Displayed)' logcat.txt | tail -40)"

crash=$(grep -A 30 "FATAL EXCEPTION" logcat.txt | head -45)
if [ -n "$crash" ]; then
  annotate error "The app crashed" "$crash"
  exit 1
fi
if ! printf '%s' "$top" | grep -qiE "eventide|chrome|browser"; then
  annotate error "Nothing of Eventide's is in front" "$top"
  exit 1
fi
