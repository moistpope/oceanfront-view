# Oceanfront View on the car's screen

An Android app that shows the [HUD page](../README.md) full screen on the car's own screen (Pulse,
the add-on board). The page and everything it needs (its scripts, three.js, the car model, the DBCs)
ship inside the APK and are served by the app itself, so the HUD is up the moment the app starts. Its
driving data comes from the car's own buses: the app reads IBUS1 and IBUS2 and the page decodes them
(the gateway mirrors the ADAS bus onto IBUS2). The comma is optional. Pulse runs the Wi-Fi hotspot it
joins; the app finds it there by itself (a browser there can't resolve `sunnypilot.local`) and relays
its API and its 20 Hz stream to the page, which merges its ADAS bus, radar and openpilot into the car's
view, and the app manages it over SSH (*Managing the comma* below). Nothing on screen waits for it or
says it's missing: no connecting card, no reconnecting pill, just a *comma* chip while it's there. The
CAN settings, driving settings and playback say they need it. A foreground service (`HudService`)
keeps the process -- the CAN reader, the link and the local server -- alive while the HUD isn't on
screen.

## How it finds the comma

Every 1.5 s while searching, all of these are asked for `/api/status` (port 8088) at once. The first
to answer as the HUD server (a 200 with its `version`, `hostname`, `urls`) wins:

1. an address set by hand (back → *Device address…*), and the last one that worked;
2. every host in the ARP table. The comma is listed as soon as it gets a DHCP lease. Apps can't read
   `/proc/net/arp` on Android 10+, so it's read through one long-lived `su` shell: grant it once on
   the rooted head unit. Without root this step is skipped and the sweep does the work;
3. hosts an earlier sweep found up but not serving port 8088 yet: a comma that has joined the hotspot
   while openpilot is still starting. These are polled until it answers.

Then every private IPv4 network the head unit is on is swept: Wi-Fi interfaces (the hotspot) first,
networks bigger than /22 narrowed to the /22 around the head unit. All connects to port 8088 go out
at once (non-blocking), so a /24 takes about a second. Sweeps repeat 2, 3, 5, 8, then every 10 s
while nothing answers, and right away when the head unit joins or leaves a network (Android can pick
a new hotspot subnet each time the hotspot starts).

## Staying connected

The page is served by the app at `http://127.0.0.1:18088` (`LocalServer`): its files from the APK's
assets (`assets/www/`, copied in from the repo at build time), and `/api/...`, the `/ws` stream and the camera view's `/video`
relayed to the comma byte for byte (HTTP and the WebSocket alike). So:

- the page's origin never changes, and its settings (kept in `localStorage`, per origin) survive the
  comma getting a new address;
- when the comma moves, the relay switches under the loaded page, which only reconnects its WebSocket;
- the relay sees the 20 Hz stream, so a healthy link costs no extra requests. When the stream stops,
  the app polls `/api/status`. Three misses in a row (about 9 s after a silent Wi-Fi drop) count as
  lost, and searching starts again with the last address first;
- the page drops a socket that has been silent for 6 s (a Wi-Fi drop can leave it half open) and
  reconnects. When the app finds the device again it tells the page (`webhud:reconnect`) to skip its
  retry backoff;
- a page that failed to load is reloaded with backoff, and a crashed WebView renderer is replaced;
- with the screen off or another app in front the app lets go of the comma, so `webhud` stops reading
  the bus, and reconnects when the HUD is shown again (the CAN reader and the server carry on).

None of this shows: the page's *comma* chip is there while the comma is and goes when it goes. Back
opens a menu: reload, look for the comma again, set its address, close.

The screen stays on and the system bars are hidden. Rotation keeps the page. The page's *auto* theme
follows the car's day/night mode.

## Loading fast

Nothing crosses Wi-Fi to start: the page, its scripts, three.js, the ~25 MB car model and the DBCs
are in the APK (`build.gradle.kts` copies them from `static/`, `third_party/` and `dbc/` at the top of
the checkout into the assets at build time, stored uncompressed so the server streams them from a file
descriptor). Each file carries an `ETag` that changes with every install, and the WebView's cache
checks it with a `304` in between. The service worker a plain browser uses (`static/sw.js`) is not
registered in the app, and one left by an earlier version is unregistered.

The page also tells the app its theme setting (`window.WebHudApp.setTheme`). With *Day* or *Night*
picked in the HUD, the app starts in that mode next time: its window, the WebView behind the page
and the starting card. So it no longer flashes the car's mode before the page loads. *Auto* keeps
following the car. The page sets its own theme before its first paint.

## Music and navigation

The HUD shows what the head unit is playing (a card at the bottom, with previous, play/pause and next)
and its navigation's next turn (a card at the top, and an arrow on the road once the turn is near).
The app gets them as a notification listener (`HudListener`), which Android lets see other apps'
media sessions and notifications:

- **Media:** every active media session is followed, and the card shows the one playing, else the most
  recent: title, artist, album, art, position and length. Its buttons go to that session's controls.
- **Navigation:** the notification in the *navigation* category, or an ongoing one from a known
  navigation app (Google Maps, Waze, HERE, Sygic, OsmAnd, MapQuest, Organic Maps). Its words go to the
  page as they are (title, text, sub text), and the page reads the distance, the maneuver and the street
  from them, along with the maneuver's picture (Google Maps draws it as the large icon). So the reading
  can be fixed by updating openpilot, without reinstalling the app.

Notification access is turned on at start through the root shell (`cmd notification allow_listener`,
for the Android user the app runs as). Without root, turn it on once by hand:

```
adb shell cmd notification allow_listener ai.sunnypilot.webhud/ai.sunnypilot.webhud.HudListener 10
```

(`10` is the user on Android Automotive; `0` on a phone.) The page asks for everything when it loads
(`window.WebHudApp.infotainment()`), then gets each change as a `webhud:media` or `webhud:nav` event;
album art and the turn's picture go along only when they change. Not tested on the car's head unit yet:
which app gives the turns there (the built-in navigation, or Android Auto / CarPlay from the phone) is
unknown. `adb logcat -s WebHud` lists every notification's app and category (not its words), and the
navigation ones in full at debug level, so it shows which app to add if none of these is it.

## The car's own buses

Pulse (the add-on SBC the app runs on) has two MCP251x CAN controllers wired to the car: `can1` =
IBUS1, `can2` = IBUS2, both 500 kbit/s. The gateway broadcasts the body, climate, powertrain and
battery status there all the time, and mirrors the ADAS bus onto IBUS2 for the head unit. The app
reads the messages listed in `CanIds.kt` (generated from the matrices by `tools/gen_ibus.py`,
with the page's `ibus_tables.js` and the IBUS DBC) and forwards every frame to the page: the car-state
read-out decodes the body messages (`static/js/carstate.js`), the world-model worker decodes the ADAS
mirror, so the HUD runs from the car alone when the comma is away (see the [main README](../README.md)).

**Sending.** The page can send the head unit's own control messages (windows, lock, liftgate, sunroof,
mirrors, lamps, climate, seat heat and moves, the locking settings) through `window.WebHudApp.canSend`.
Only the IDs in `CanIds.TX` go out, and that allowlist is enforced twice: in `CanBridge.send` and in the
helper, which only opens a transmit socket for the IDs it was given on its command line. A frame is
refused when the bus is silent (the car asleep, or the link down) or past 60 frames a second. Silent
means no frame on that bus has changed for 3 s: the helper's once-a-second repeats of an unchanged frame
(below) go on after the bus falls quiet, so they don't count, while an awake bus always has something
changing, since most messages carry an alive counter or a checksum. Every frame sent is logged (`adb
logcat -s WebHud`, `CAN send`, and the helper's `tx ... ok`). The head unit's cyclic state messages
(drive mode and charging, units and brightness, ambient light and California Mode) are never sent: the
head unit would send its own values right back, and some carry an E2E counter. Nor are the audio
messages, whose one frame carries every volume and the mute. What the app sends never loops back into
what it reads.

The reading and sending are done by a bundled helper, `libcanbridge.so` (`canbridge/main.go`): a plain
executable shipped as a `.so` so Android installs it into the app's `nativeLibraryDir`, the one directory
an app may exec from (`android:extractNativeLibs="true"`, `useLegacyPackaging`). It needs no root: an app
can open CAN sockets here, the same way Pulse's own app does. It forwards a frame at once when its
payload changes and repeats every ID's current frame once a second, so the page can tell a steady value
(climate, seat heat, a window's position) from a silent bus. Frames to send come to it on stdin, one
per line, and it answers each on stdout. The page asks for the current state when it loads
(`window.WebHudApp.canState()`), then gets frames as `webhud:can` events, ~15 Hz batches (every screen
frame in Ready, see [Full speed in Ready](#full-speed-in-ready)).

Rebuild the helper (needs only the Go toolchain) with `canbridge/build.sh`. `adb logcat -s WebHud`
shows `CAN helper: ready` and `CAN frames flowing` when it's up.

Pulse's CAN driver (an out-of-tree mcp251x) programs the chips' hardware acceptance filters from
module parameters: per chip (`_0` = can1 = IBUS1, `_1` = can2 = IBUS2) `rxb_mask_<chip>` holds the
masks of receive buffers 0 and 1, `rxb_filter_<chip>` their six filters (two for buffer 0, four for
buffer 1), and a write to `apply_filters` programs them; an ID passes when `(id & mask) == (filter &
mask)` for some filter of a buffer. Its defaults pass only parts of the ID range (IBUS1 roughly
0x200–0x3FF and 0x500–0x7FF, IBUS2 0x200–0x23F, 0x300–0x37F, 0x500–0x53F, 0x580–0x5BF), which loses the
seat and mirror positions (0x4F3, 0x4F5), the liftgate (0x471), the steering angle and yaw rate (0x1C2,
0x112), the battery current (0xE9), the charging times (0x630, 0x634) and the odometer (0x641). So at
start `HwFilters` writes the plan in `CanIds.HW_FILTERS` instead: `gen_ibus.py` searches the tightest
masks and filters that let every ID in `CanIds.RX` through (IBUS1 0x200–0x5FF plus four 8-ID windows
in 0x100–0x1FF, IBUS2 0x000–0x3FF plus 0x500–0x53F, 0x580–0x5BF, 0x600–0x67F). The files belong to
root, so it goes through the app's root shell (`Link.root`); without root the driver's own values stay
and the log says so (`CAN hardware filters left as they are`). The wider filters mean more SPI
interrupts for IDs we don't read; the kernel-side `CAN_RAW` filters in the helper still keep those from
the app.

Pulse drops a large share of received frames (about half on IBUS1, two-thirds on IBUS2): both CAN
controllers share one SPI bus and every interrupt lands on CPU 0. Status messages repeat, so the
read-out still settles; it just lags. In Ready the app moves those interrupts off CPU 0 and raises their
threads' priority ([Full speed in Ready](#full-speed-in-ready)); the SoC's own CAN controller would help
more, for Pulse's own app too.

## Full speed in Ready

While the car is in Ready (the READY lamp, `VCU_RdyLamp`, IBUS1 0x234 byte 1 bit 4, read by
`CanBridge` as the frames come in), `PerfBoost` runs Pulse flat out, and puts everything back when
Ready ends, when 0x234 stops changing for 3 s (the bus went quiet: the helper only repeats it) or when
the page's switch goes off (*Display → Debug → Full speed in Ready*, on by default; the app keeps the
setting, so it applies from the app's start, before the page loads). It lives in `HudService`, so it
also ends with Ready while the HUD is off screen.

- `CanBridge` hands the page its frames every 16 ms (once a screen frame) instead of every 66 ms.
  Needs no root.
- With root (`Link.root`): every CPU cluster's `scaling_min_freq` is raised to its `scaling_max_freq`,
  and the same for the GPU's devfreq devices (`/sys/class/devfreq/*` named gpu, kgsl, mali...: on
  Adreno also its bus, gpubw). The governors and the thermal limits are left alone: a thermal cap
  lowers the maximum and the minimum follows it, so a hot screen still slows itself down.
- With root: the CAN chips' interrupts (named `mcp251x`, or after their SPI device, `spi1.0`) and
  their SPI controller's (after its platform device, from `/sys/class/net/can1/device`) move from
  CPU 0 to the last core of CPU 0's cluster (`smp_affinity_list`), away from every other interrupt
  and off the big cores the HUD draws on. Their interrupt threads (`irq/<n>-...`) and the controller's
  message thread (`spi1`) go to `SCHED_FIFO` 80, above the 50 the kernel gives interrupt threads
  (toybox `chrt`).

`assets/perf/probe.sh` reads all of that, read-only, and `PerfPlan` (unit-tested in `PerfPlanTest`)
works out what to write, what puts each value back and how much took. The way back is saved
(`files/perfboost-restore.sh`, a shell script headed by the boot ID) before anything is written, so a
process that dies boosted puts it back when it starts again; a script from an earlier boot is dropped,
since a restart resets it all. The switch's status line shows what took, e.g. *CPU clusters at top
speed 3/3 · GPU 2/2 · CAN interrupts on CPU 3 2/3 · CAN threads at real-time priority 4/4*: an
interrupt that won't move (some GPIO interrupt controllers can't) or a thread missing from the count
is the device saying no. `adb logcat -s WebHud` logs each boost and its result.

## Managing the comma

The page's *Comma* tab talks to `CommaManager` at `/app/comma/...` on the local server, with a token it
gets from `window.WebHudApp.appToken()` (the server is on loopback, which other apps can reach too).

- **The key** (`SshKey`): ECDSA P-256, made in the Android Keystore under `comma-ssh`; JSch signs with it
  there through a custom `Identity` (`SshWire` has the SSH encodings). *Authorize* posts its OpenSSH line to
  the bridge's `/api/ssh/authorize`, which adds it to `GithubSshKeys` and sets `SshEnabled`; deleting the key
  takes it off the comma first.
- **SSH** (`CommaSsh`, [JSch](https://github.com/mwiede/jsch)): one session as `comma@<the comma>:22`, kept
  open and shared, a command per exec channel. The host key is pinned on first use; another one is refused
  (*Trust the new host key* in the tab after a reflash).
- **Scripts** (`app/src/main/assets/comma/`): `prelude.sh` (paths, the venv's python, how openpilot stops and
  starts), then `actions.sh` (the jobs), `info.py` (processes, device, install, updater) or `routes.py`.
  Each runs as `bash -c` so nothing in it reads the rest from stdin. Jobs run on the app and keep their last
  512 kB of output; the page follows them by offset. Start, stop, restart, reboot, pull, branch, install,
  restore, the panda and commands are refused while the car moves (the bridge's `/api/status`, or the speed
  the page sends).

`adb logcat -s WebHud` logs each job's title (`comma job N: ...`).

## Build and install

Needs JDK 17+ and the Android SDK (`ANDROID_HOME`, or `sdk.dir` in `local.properties`).

```
cd android
./gradlew assembleRelease        # app/build/outputs/apk/release/app-release.apk, ~28 MB (the page and the car model are in it)
./gradlew testDebugUnitTest      # JVM tests: subnet math, ARP parsing, status probe, sweep, relay, app API, SSH encodings, updates
adb install -r app/build/outputs/apk/release/app-release.apk
```

Release builds are signed with the debug key, since the app is sideloaded, not published.
A built APK is attached to each release on GitHub (https://github.com/moistpope/oceanfront-view/releases).

The APK must be rebuilt for a change to the page (its files are copied in at build time); `serve.py` at
the top of the checkout serves the same files to a plain browser.

On Android Automotive, an app that isn't *distraction optimized* is blocked while driving. The
activity declares `distractionOptimized`, but on user builds the car service only honors that for
system apps or apps from an allowlisted store. If the HUD is blocked when the car moves, install it
as a system app on the rooted head unit (e.g. under `/system/priv-app`).

## Updating itself

The car menu's *Software* sheet shows the app's version and checks the repository's latest GitHub
release (`AppUpdater`, at `/app/update`; drafts and pre-releases aren't offered) when it opens, at
most every 30 minutes, or on *Check for updates*. A release is an update when its tag (`v1.2`) is a
higher version than the installed `versionName`, and it has an `.apk` attached. *Install* downloads
it and checks it before installing: its size and the SHA-256 GitHub keeps for the asset, its package,
that it isn't an older `versionCode`, and that it is signed with the same key as the installed app.
With root, `pm install` replaces the app silently and starts it again; without, Android's installer
asks on screen (the first time, to allow this app to install apps). The HUD restarts either way, so
installing is refused while the car moves.

### Cutting a release

**Every release must bump the version**, or the cars never see it as an update (or keep offering the
same one after installing it): `versionName` in `app/build.gradle.kts` to the release's version (the
tag is `v<versionName>`), and `versionCode` up by one. `tools/release.sh` does that and the rest:

```
tools/release.sh                 # 1.0 -> 1.1: bump, run the tests, build, commit "Oceanfront View v1.1", tag v1.1
tools/release.sh patch           # 1.1 -> 1.1.1 (or major, or a version: tools/release.sh 2.0)
tools/release.sh --publish       # ...then push the commit and the tag and create the GitHub release with the APK (gh)
```

It wants a clean checkout, puts the version back if the tests or the build fail, and names the APK
`app/build/outputs/apk/release/oceanfront-view-v<version>.apk`. Without `--publish` it prints the
push and `gh release create` commands to run.

Build releases with the same debug key as the APKs already on cars (the `~/.android/debug.keystore`
of the machine that built them): Android won't install an APK signed by another key over the app, and
the app says so instead of trying. The script checks the APK's signer against that key's SHA-256
(`SIGNER` in the script) and stops before committing if it differs.

## Debugging

`adb logcat -s WebHud` shows how the comma was found, sweeps (debug level), losses and reloads, and
the media session and navigation notification the HUD is showing. The
WebView can be inspected from `chrome://inspect` on a computer with adb access to the head unit.

## UK traffic and camera speed signs

In Display → General, select **Traffic side → Left (UK)** and
**Camera speed-sign units → mph**. Traffic side controls placement on two-way
map roads and the side used for camera signs. Camera speed-sign units describe
the incoming camera number; Speed units independently select its display units.
For example, a UK 30 sign stays 30 with an mph display, or becomes 48 with a
km/h display. Follow car uses the original CAN unit flag. These overrides are
saved on the device and must be changed when the road/sign conventions change.

These changes have automated JavaScript coverage; car hardware validation is
still required.
