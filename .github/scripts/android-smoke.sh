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
sleep 20
adb logcat -d > logcat.txt
adb exec-out screencap -p > android-screen.png
top=$(adb shell dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity" | head -3)
annotate notice "In front after 20 s" "$top"
annotate notice "App log" "$(grep -iE 'eventide|chromium|ActivityTaskManager: (START|Displayed)' logcat.txt | tail -40)"
adb shell uiautomator dump /sdcard/screen.xml >/dev/null 2>&1
screen=$(adb exec-out cat /sdcard/screen.xml)

crash=$(grep -A 30 "FATAL EXCEPTION" logcat.txt | head -45)
if [ -n "$crash" ]; then
  annotate error "The app crashed" "$crash"
  exit 1
fi
if ! printf '%s' "$top" | grep -q "io.github.vaibhavmannq.eventide"; then
  annotate error "The app is not in front" "$top"
  exit 1
fi
# The site, inside the app's own window: its sign-in buttons are on the screen.
if ! printf '%s' "$screen" | grep -q "Sign in with"; then
  annotate error "The app is open but the site is not showing" "$(printf '%s' "$screen" | grep -oE 'text="[^"]+"' | head -20)"
  exit 1
fi
annotate notice "Showing the site" "$(printf '%s' "$screen" | grep -oE 'text="[^"]+"' | head -8)"
