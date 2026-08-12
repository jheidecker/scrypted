# Fork notes: `@scrypted/onvif` with WS-BaseNotification push

Operational notes for running this fork in production and keeping it current with upstream.
This file describes the fork itself, not the plugin — **drop it, and the version pin commit,
before opening any upstream pull request.**

- Fork: `jheidecker/scrypted`
- Branch: `onvif-base-notification-push`
- Base: upstream `koush/scrypted` @ `70c2597`
- Scope: `plugins/onvif` only

## Why this fork exists

TP-Link/Tapo cameras advertise `WSPullPointSupport=true` and accept a PullPoint subscription,
then never deliver events. Scrypted's five minute idle watchdog tears the listener down and
rebuilds it, forever, and no motion or object detection ever reaches Scrypted. The same cameras
deliver events correctly over ONVIF WS-BaseNotification, where the camera POSTs to a callback.

This branch adds Push as an opt-in per camera transport, keeps PullPoint as the default, and maps
the Tapo detection rules to Scrypted object classes. Upstream declined the approach in
[#1107](https://github.com/koush/scrypted/issues/1107) in Feb 2024, which is why this is a fork.

## What it touches

| Path | Note |
|---|---|
| `plugins/onvif/src/main.ts` | Not shared. Endpoint, settings, device wiring. |
| `plugins/onvif/src/onvif-api.ts` | **Symlinked into `plugins/reolink/src`.** |
| `plugins/onvif/src/onvif-events.ts` | **Symlinked into `plugins/reolink/src`.** |
| `plugins/onvif/test/test-events.ts` | New. `npm test`. |
| `plugins/onvif/package.json` | devDeps, `test` script, fork version pin. |

Two of those files are git symlinks shared with the Reolink plugin, so **always build
`plugins/reolink` as well** — a change that compiles here can still break Reolink.

Nothing outside `plugins/onvif` is modified. Reolink is unaffected at runtime: every new
parameter is optional and defaults to the previous behaviour.

---

# Running the fork in production

## The autoupdate trap — read this first

Scrypted auto-creates an **"Autoupdate Plugins"** automation that runs **daily at 03:15** and
calls `updatePlugins()` (`server/src/services/plugin.ts:143`):

```ts
if (!semver.gt(version, host.packageJson.version)) continue;   // npm latest vs installed
await this.installNpm(plugin);                                 // otherwise reinstall from npm
```

A fork deployed over the official plugin keeps the name `@scrypted/onvif`. If it also keeps
upstream's version, **the first upstream release silently replaces it overnight** and every
camera reverts to the broken PullPoint behaviour, with no error and no obvious signal.

This branch therefore pins the version to `99.<upstream minor>.<upstream patch>` — currently
`99.1.31`, meaning "fork of 0.1.31". That sorts above anything upstream will publish, so the
autoupdater skips it.

A prerelease tag does **not** work. Prereleases sort *below* the matching release, so
`0.1.32` would still overwrite `0.1.32-fork.1`:

```
npm 0.1.32 vs fork 0.1.31         -> OVERWRITES FORK
npm 0.1.32 vs fork 0.1.32-fork.1  -> OVERWRITES FORK
npm 0.1.32 vs fork 99.0.0         -> fork kept
```

**Do not disable the Autoupdate Plugins automation instead** — that would freeze every other
plugin too.

## Build prerequisites

The repo does not build out of the box on a current Node. Both problems are upstream, not from
this branch, and both are local-only workarounds that are deliberately not committed:

```bash
./npm-install.sh                                    # will fail on server/, that is expected

# @scrypted/node-pty has no prebuilt binary for recent Node and fails node-gyp.
# the server package is only needed for types here, so skip its native build:
(cd server && npm install --ignore-scripts)

# @types/node@20 is incompatible with the SDK's TypeScript 5.9: Buffer stops being assignable
# to Uint8Array and common/ fails to compile. align every package that gets compiled in:
for d in common plugins/onvif plugins/rtsp plugins/ffmpeg-camera plugins/webrtc plugins/reolink; do
  (cd $d && npm install --no-save --no-package-lock @types/node@^24.9.2)
done
```

`npm test` additionally needs `ts-node` and TypeScript 5.x, both declared in the plugin's
devDependencies. Do not let `typescript@7` get installed — ts-node cannot drive it (`ts.sys` is
undefined) and the tests will not run.

## Build, test, deploy

```bash
cd plugins/onvif
npm test                                # 33 assertions
npm run build                           # -> out/plugin.zip
cd ../reolink && npm run build          # shares the symlinked sources
cd ../onvif

npx scrypted login <host>               # interactive, once; token -> ~/.scrypted/login.json
npm run scrypted-deploy <host>          # host defaults to port 10443
```

`scrypted-deploy` POSTs `package.json` to `/web/component/script/setup` and `out/plugin.zip` to
`/web/component/script/deploy` (`sdk/src/bin/index.ts`). The package name is unchanged, so it
**upgrades the existing plugin in place**: cameras are not deleted, re-added, or reconfigured, and
device ids are preserved. One deploy updates every ONVIF camera at once.

## Confirming the fork is what is running

The plugin console header prints the version on load:

```
plugin version: @scrypted/onvif 99.1.31      <- fork
plugin version: @scrypted/onvif 0.1.31       <- official build, fork has been overwritten
```

Worth checking after any Scrypted server upgrade.

## Rollback

Reinstall `@scrypted/onvif` from npm in the Scrypted UI. That replaces the fork with the current
official build and, because the official version is lower, **also re-arms the autoupdater**.
Camera settings persist, including the fork-only keys, which are simply ignored by the official
plugin. Cameras pinned to Push revert to PullPoint behaviour, meaning no events on Tapo.

Never hand-edit Scrypted's volume to roll back.

---

# Keeping current with upstream

```bash
git fetch upstream
git switch onvif-base-notification-push
git rebase upstream/main
```

Then, in order:

1. **Re-pin the version.** Rebasing takes upstream's `package.json`, which will reset the version
   and re-arm the autoupdater. Set it back to `99.<upstream minor>.<upstream patch>`.
2. **Rebuild both plugins.** `plugins/onvif` and `plugins/reolink`.
3. **Run the tests.** They cover the classifier, which is where upstream changes are most likely
   to collide.
4. **Redeploy and re-verify** at least: push subscribe, one detection, one renew cycle.

## Where conflicts will happen

Almost all of this branch lives in three files, and `onvif-api.ts` carries the classifier that
upstream is most likely to touch:

- `onvif-api.ts` — the `handleNotification` topic chain. Upstream adding a vendor branch will
  conflict here. Keep both branches; ordering matters, since the chain is first-match-wins and
  the user-configurable `binaryStateEvent` check sits ahead of the rule-specific ones.
- `onvif-events.ts` — `listenEvents` signature. Upstream changing its parameters will conflict
  with the options object.
- `main.ts` — `getOtherSettings`, `putSetting`, `updateDevice`, `listenEvents`.

If upstream ever reimplements the ONVIF client (koush mentioned intending to), this branch will
need reworking rather than rebasing — the transport assumes the `onvif` npm library's
`subscribe`/`renew`/`unsubscribe` and its `parseEventXML`.

---

# Per-camera settings added by this fork

All under **Advanced**.

| Setting | Default | Notes |
|---|---|---|
| **ONVIF Event Transport** | `Auto` | `Auto` uses PullPoint and only falls back to Push if the subscription cannot be *created*. Tapo accepts creation and then goes silent, so **Auto will not rescue a Tapo** — select `Push (WS-BaseNotification)` explicitly, per camera. |
| **ONVIF Push Callback** | read-only | The URL the camera posts to. Shown when Push is enabled. |
| **Motion Sensor Events** | `Motion` | Which events set `motionDetected`. Selecting a detection class instead makes the HomeKit camera accessory's snapshot notification fire only for that class. Selecting nothing leaves the motion sensor unused. |
| **Log ONVIF Events** | off | Logs every event to the camera console and to a file. See below. |

Detection classes mapped from Tapo rules: `IsPeople` → `person`, `IsVehicle` → `vehicle`,
`IsPet` → `animal`. The last two come from `TPSmartEventDetector`, which declares only
`IsTPSmartEvent` and carries the rest at runtime.

## HomeKit

HAP's motion characteristic is a plain boolean, so a bridged camera can only ever report
"motion". Typed notifications come from HomeKit Secure Video, which classifies the video clip
itself and ignores camera metadata. For per-class notifications without HKSV, point a **Smart
Motion Sensor** (`@scrypted/objectdetector`) at a single class and bridge it as its own
accessory — the class then lives in the accessory name. Those sensors are text-only; only the
camera accessory carries a snapshot, which is what **Motion Sensor Events** is for.

---

# Diagnostics

## Event log

With **Log ONVIF Events** on, every notification is appended as a JSON line to
`$SCRYPTED_PLUGIN_VOLUME/onvif-events.log`, which for a Docker install is:

```
/server/volume/plugins/@scrypted/onvif/onvif-events.log
```

One shared file across all cameras, tagged with camera name and id, rotating to `.log.1` past
16 MB. The management console is only a capped in-memory buffer, so this file is the only thing
that survives.

```bash
# every topic + property combination seen
jq -r '.topic as $t | .data | keys[] | "\($t) \(.)"' onvif-events.log | sort -u

# anything this plugin does not classify
jq -r 'select(.topic | test("CellMotionDetector|PeopleDetector|TPSmartEventDetector|ObjectDetector") | not)' onvif-events.log
```

Turn it off when not surveying — the file grows continuously.

Unhandled properties are reported even with the toggle off, once per `(topic, property)`:

```
unhandled onvif event property: RuleEngine/TPSmartEventDetector/IsPackage
```

That is the line to watch when adding a new camera model. Adding a mapping is one line in
`TPSMART_DETECTION_CLASSES` in `onvif-api.ts`.

## Which cameras are on Push

The push endpoint only exists on cameras using Push, so a GET that returns 405 identifies them:

```bash
for i in $(seq 1 150); do
  ( code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 4 \
      "http://<server>:11080/endpoint/$i/public/push/probe")
    [ "$code" = "405" ] && echo "device $i: push active" ) &
done; wait
```

## Log lines that matter

```
onvif event transport: push
onvif push subscription active;  lease=120s; renew in=78s
onvif push subscription renewed; lease=120s; renew in=78s     <- expected every ~78s
onvif push subscription replaced                              <- camera rejected a renewal
listen loop error, restarting listener                        <- full rebuild, should be rare
onvif push callback body could not be decoded. content-type:  <- see limitations
```

---

# Known limitations

- **`text/xml` callbacks would not work.** The Scrypted server parses endpoint bodies before the
  plugin sees them. `application/soap+xml` arrives as a JSON-serialized Buffer and is unwrapped;
  `text/xml` matches no parser and arrives as the literal `"{}"`, losing the payload. Every
  camera tested posts `application/soap+xml`. A camera that does not would need a one-line change
  in `server/`, outside this branch. The decode failure is logged once with the observed
  content-type.
- **The camera's `UtcTime` is not trustworthy** and is never used for freshness, ordering or
  dedupe. Observed in the field: a detection arriving 16 hours after the timestamp the camera put
  on it. It is recorded in the debug log for diagnosis only.
- **Push reverses the connection direction.** The camera must reach the Scrypted host on the
  insecure port (11080 by default). Fine on a flat LAN with Docker host networking; a camera VLAN
  would need a firewall rule. There is deliberately no manual callback-address override, since
  none proved necessary.
- **Cluster mode is untested.** A callback must reach the process owning the route.
- **The motion-event gating has no unit test.** `onvif-events.ts` imports `@scrypted/sdk` as a
  value, and the SDK cannot load outside the plugin host, so `listenEvents` is not reachable from
  the test harness. The classifier it feeds is covered; the gating itself was verified live only.
- **No soak beyond a few hours** at time of writing.

# Verified on

Scrypted 0.143.0, Docker host networking, Ubuntu 22.04 x64. Six TP-Link Tapo cameras: C320WS ×3,
C325WB, C560WS, C110. Full results are in `SCRYPTED_ONVIF_PUSH_PR_DRAFT.md`.
