# Snap5 for Mac

A menu bar app that takes Snap5 screenshots in any Mac app. The selection and markup UI is the same code as the Chrome extension.

## Build and install

Needs only the Apple Command Line Tools (macOS 14 or later, Apple silicon).

```sh
./build.sh install
open /Applications/Snap5.app
```

To make the download for other people (`../dist/Snap5-Mac.zip`): `./build.sh package`

## Permissions (System Settings → Privacy & Security)

| Permission | Needed for |
|---|---|
| Screen & System Audio Recording | taking any screenshot |
| Input Monitoring | `5 5` and `5 5 5` |
| Accessibility | ignoring `5` while typing in a text box |

Quit and reopen Snap5 after changing them. The app is signed ad hoc, so macOS may ask again after a rebuild: remove Snap5 from each list and add it again.

## Keys

| Keys | Action |
|---|---|
| `5 5` or `⌃⌥S` | select an area, or click a window; mark up; `Return` copies, `⌘S` saves, `⌘P` pins |
| `5 5 5` or `⌃⌥F` | copy the whole screen under the mouse |

In Google Chrome the `5` key is left to the extension (can be changed in the menu).

## Test

**The test takes over the screen and keyboard for about 20 seconds.** Run it only when nobody is using the Mac.

```sh
./build.sh && SNAP5_SELFTEST=i-am-not-using-this-mac ./build/Snap5.app/Contents/MacOS/Snap5 --selftest /tmp/snap5-selftest
```

The self-test uses a drawn picture and a private clipboard. It does not test real screen capture or the global keys, which need the permissions above.

## Not in the Mac app yet

Scrolling full-window capture, screen recording, the full editor window and a history browser. Use the Chrome extension for those. Sharing the app with other people also needs an Apple Developer ID signature and notarization.
