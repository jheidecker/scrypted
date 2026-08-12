# Draft upstream PR — not submitted

This branch is intentionally **not** open as an upstream PR. Upstream issue
[#1107](https://github.com/koush/scrypted/issues/1107) was closed by koush in Feb 2024 with
*"no plans to implement this due to possible reachability issues and questionable additional
value. I'll keep it in mind if/when I get to the onvif reimplementation."*

The branch is nevertheless structured as thirteen reviewable commits so it can be opened later
without redoing the work:

```
onvif: normalize event notification payloads
onvif: add WS-BaseNotification push event transport
onvif: support Tapo person and vehicle events
onvif: replace the push subscription when renew is rejected
onvif: claim vehicle from the advertised Tapo smart event rule
onvif: allow a detection class to drive the motion sensor
onvif: allow the motion sensor events selection to be empty
onvif: add an option to log every event a camera reports
onvif: signal settings changes from the early returning putSetting branches
onvif: keep the push callback token stable across listener restarts
onvif: persist debug events to a file in the plugin volume
onvif: stop blocking the settings ui on server round trips
onvif: map the Tapo pet detection to the animal class
```


```bash
git push origin onvif-base-notification-push
gh pr create --repo koush/scrypted --base main \
  --head jheidecker:onvif-base-notification-push \
  --title "onvif: add WS-BaseNotification push event transport" \
  --body-file SCRYPTED_ONVIF_PUSH_PR_DRAFT.md   # strip this header section first
```

Note this file is untracked on purpose — it must not become part of the PR diff.

---

## Summary

Adds an optional ONVIF WS-BaseNotification push event transport alongside the existing PullPoint
implementation.

This addresses ONVIF devices that successfully advertise and create PullPoint subscriptions but
do not deliver usable events through PullMessages. The behaviour reproduces on current TP-Link/Tapo
firmware and was previously reported in #1107.

Default behaviour is preserved. `Auto` continues to use PullPoint and only falls back to Push on a
concrete PullPoint setup failure — never on event silence, since a camera can legitimately have
nothing to report. A camera can also be pinned to Push explicitly.

## Implementation

- A Scrypted-managed local HTTP callback endpoint via `HttpRequestHandler` / `EndpointManager`.
  No extra listener and no hard-coded port. The endpoint is public and insecure because cameras
  cannot authenticate with Scrypted and generally will not trust its self-signed certificate.
- The endpoint interface is only reported by cameras actually using Push, so PullPoint cameras are
  unchanged.
- `Subscribe`, `Renew` and `Unsubscribe` use the existing `onvif` library. Push never attaches a
  camera `'event'` listener, because the library starts a PullPoint subscription as soon as one is
  added and both transports share `cam.events.subscription`.
- PullPoint and Push notifications go through one shared classifier, so the two paths cannot
  diverge.
- Multiple `tt:Source` / `tt:Data` `SimpleItem` entries are normalized into dictionaries. The
  previous parser only ever read the first entry, so multi-valued messages were dropped.
- `xs:boolean` accepts `"1"`/`"0"` as well as `"true"`/`"false"`; non-boolean values such as the
  Mobotix `"Ring"` are never coerced.
- `PropertyOperation="Initialized"` no longer surfaces as an object detection.
- Tapo person (`IsPeople`), vehicle (`IsVehicle`) and pet (`IsPet`) mappings. The smart classes
  are claimed from the advertised `TPSmartEventDetector` rule, because that rule declares only
  `IsTPSmartEvent` while carrying the rest at runtime; classes seen at runtime with no
  corresponding rule are still discovered and persisted.
- An optional per camera event log, to console and to a file in the plugin volume, for
  identifying what a given model actually reports. Off by default.
- An optional selection of which events set the motion sensor, so a consumer that only
  understands a motion sensor can be driven by a detection class. Defaults to the motion rule.

## Why local receive time

Some tested Tapo firmware reuses an old `tt:Message UtcTime` for later live notifications. Treating
that field as freshness or ordering metadata discards valid detections. Scrypted's `ObjectsDetected`
already uses `Date.now()`; the parser retains camera time for diagnostics only.

Subscription renewal has the same problem in reverse, so the lease is derived from the *relative*
difference between the camera's reported `CurrentTime` and `TerminationTime` and applied to the
local clock. A camera with a wrong clock or timezone still renews correctly.

## Renewal and listener lifecycle

`RtspSmartCamera.listenLoop` destroys a listener that has been idle for five minutes. A push camera
may legitimately be quiet for much longer, so a successful renew emits listener activity. Renew runs
at 65% of the accepted lease, bounded, with a short retry while lease time remains. Once the lease is
known lost the listener is torn down and rebuilt rather than stacking a second subscription.

Teardown is idempotent: it cancels timers, drops the callback registration and unsubscribes.
Dropping the registration is what makes the endpoint reject callbacks. The token is held in memory
only and generated once per device instance, so a plugin reload produces a new one and a camera
still holding a subscription from the previous process is rejected, while the url stays stable
across a listener restart.

## Compatibility

`plugins/reolink/src/{onvif-api,onvif-events,onvif-intercom}.ts` are symlinks to this plugin's
sources. `listenEvents`'s signature and the `'onvifEvent'` payload shape are unchanged, the new push
parameter is optional, and the Reolink plugin was built as part of verification.

## Testing

Automated — `cd plugins/onvif && npm test` (33 assertions, all passing):

- single and multiple `SimpleItem` normalization, singleton and array shapes
- boolean normalization: `"true"`/`"false"`/`"1"`/`"0"`, and `"Ring"` preserved as a string
- PullPoint regression fixtures: MotionAlarm, DetectedSound, Reolink Visitor, Mobotix
  `VideoSource/Alarm`, configured binary event, CellMotionDetector, standard ObjectDetector
- a pushed Notify classifies identically to the equivalent pulled message
- one POST carrying multiple `NotificationMessage`s dispatches all of them
- malformed XML and malformed notifications do not throw
- repeated/stale camera `UtcTime` does not suppress the second event
- lease derived from relative termination time; fallback to the requested `PT2M`; renew failure
  propagates
- Tapo person, vehicle and pet fixtures, including classes the advertised schema never declares;
  several smart classes in one message; `Initialized` suppressed; unknown smart fields reported
  as unhandled rather than guessed at
- the advertised rules resolving to the classes they carry, and to nothing on a camera without
  them
- the event debug record's shape, and that it stays silent unless enabled

Build:

```bash
./npm-install.sh
cd plugins/onvif  && npm run build   # ok
cd ../reolink     && npm run build   # ok, shares the symlinked sources
```

Live:

- Base commit: `70c2597`
- Plugin version: `@scrypted/onvif` 0.1.31
- Scrypted server: 0.143.0, Docker with host networking, Ubuntu 22.04 x64
- Camera: TP-Link Tapo C320WS, ONVIF 20.6, service on port 2020

Verified on that camera:

- [x] **PullPoint reproduces the reported failure.** The camera advertises
      `WSPullPointSupport=true`, accepts the subscription, then delivers nothing until Scrypted's
      five minute idle watchdog tears the listener down — repeatedly. Unchanged by this branch.
- [x] Push startup: callback logged as
      `http://<server>:11080/endpoint/<device-id>/public/push/<token>`,
      `subscription active; lease=120s; renew in=78s`.
- [x] Callback body decodes. This camera posts `application/soap+xml`, which the server's global
      raw body parser hands to the plugin as a JSON-serialized Buffer; `decodePushBody` unwraps it.
- [x] Endpoint routing and rejection, exercised with curl from another host on the LAN:
      `GET` → 405, unknown/expired token → 410, unknown route → 404.
- [x] Person → `ObjectsDetected className=person`.
- [x] Vehicle → `ObjectsDetected className=vehicle`, and pet → `className=animal`, both from a
      rule that declares neither.
- [x] Generic `CellMotionDetector/Motion` → `motionDetected`.
- [x] Camera supplied time confirmed untrustworthy in the field. A pet detection arrived with
      `cameraUtcTime` 16 hours behind `receivedAt`, on a camera that was reporting correctly
      throughout. Any freshness or ordering logic keyed on that field would have discarded it.
- [x] Renew cycles at 78s intervals with no listener restart and no duplicate subscription.
- [x] Camera reboot recovers without restarting Scrypted. The reboot invalidates the subscription
      and the camera then faults every `Renew`, which is what motivated replacing the subscription
      rather than retrying the renewal.
- [x] Plugin redeploy while subscribed: old token rejected, exactly one new subscription.
- [x] `getObjectTypes()` reports `person` and `vehicle`, so both are selectable by downstream
      consumers such as the object detector plugin's Smart Motion Sensor. Detections carry no
      score, and that sensor's `if (d.score && d.score < minScore)` filter passes them through
      rather than rejecting them against its 0.7 default:
      `Smart Motion Sensor triggered on { score: undefined, className: 'person' }`
      `Smart Motion Sensor triggered on { score: undefined, className: 'vehicle' }`

Deployed across six Tapo cameras: C320WS x3, C325WB, C560WS, C110.

Not verified:

- Cameras from other vendors, and cluster deployments.
- Soak longer than a few hours.

## A note on HomeKit

HAP's motion characteristic is a plain boolean, so a bridged camera can only ever report
"motion" regardless of what Scrypted knows. Typed Home notifications come from HomeKit Secure
Video, which classifies the uploaded clip itself and does not read camera metadata. Per-class
notifications without HKSV are possible today by pointing a Smart Motion Sensor at a single
class and bridging it as its own accessory, which is how the two log lines above were produced.
None of that needs changes in this plugin.

## Related

Addresses #1107.
