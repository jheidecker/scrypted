# Agent Implementation Plan: ONVIF WS-BaseNotification Push Events for Scrypted

## Mission

Implement, test, deploy, and upstream a maintainable ONVIF event transport enhancement in the forked `koush/scrypted` repository.

The goal is to make ONVIF cameras that advertise PullPoint but do not actually deliver usable PullPoint events—validated with TP-Link/Tapo cameras—work natively in Scrypted using the ONVIF **WS-BaseNotification / Basic Notification push** mechanism.

The implementation must:

1. Preserve existing PullPoint behavior for cameras that already work.
2. Add a first-class **Push / Base Notification** event transport.
3. Use Scrypted's own HTTP endpoint infrastructure for camera callbacks.
4. Use the camera's standard ONVIF `Subscribe`, `Renew`, and `Unsubscribe` lifecycle.
5. Normalize push and pull notifications through the same event parsing path.
6. Correctly handle multiple `SimpleItem` values and vendor-specific topics.
7. Treat camera `UtcTime` as informational only for event freshness/deduplication.
8. Surface confirmed Tapo person and vehicle detections as Scrypted `ObjectDetector` events.
9. Continue setting Scrypted motion state so existing HomeKit motion notifications work without HKSV analysis.
10. Be safe to install over the existing `@scrypted/onvif` plugin on a running Scrypted server.
11. Include automated tests, live-camera tests, rollback instructions, and an upstream-ready pull request.

Do **not** implement this by forking the Tapo plugin. The transport problem belongs in `plugins/onvif`. The existing Tapo plugin is currently a mixin used primarily for Tapo two-way audio, while ONVIF camera import and event processing live in `plugins/onvif`.

---

# 1. Known-good experimental findings

Treat the following as empirical requirements, not hypotheses.

## 1.1 PullPoint is advertised but does not produce usable live events on the tested Tapo

The tested Tapo camera advertises:

- `WSPullPointSupport=true`
- `WSSubscriptionPolicySupport=true`

Scrypted's current ONVIF code checks/logs PullPoint capability but then creates a PullPoint subscription unconditionally.

On the affected Tapo firmware, PullPoint subscription creation succeeds, but live motion/person events do not arrive reliably.

This reproduces the problem described in Scrypted issue #1107.

## 1.2 WS-BaseNotification push works

A standalone Node test using the same `onvif` npm library successfully used:

```js
cam.subscribe({ url: callbackUrl }, callback);
```

The camera then HTTP POSTed ONVIF `Notify` messages to the callback.

Confirmed live Tapo topic:

```text
tns1:RuleEngine/PeopleDetector/People
```

with:

```text
IsPeople=true
```

## 1.3 Normal PT2M Subscribe + Renew works

This was tested across three or more renewal cycles.

The successful lifecycle is:

```text
Subscribe PT2M
    |
    +-- live events
    |
Renew PT2M
    |
    +-- live events
    |
Renew PT2M
    |
    +-- live events
```

Do not carry forward earlier experimental workarounds that disabled Renew, rotated subscriptions, or requested long leases. Those were investigated before the actual timestamp bug was isolated.

For the initial Scrypted implementation, use the library's normal two-minute Base Notification subscription and Renew behavior.

## 1.4 Tapo event `UtcTime` is not trustworthy

This was the main debugging discovery.

The camera can emit a new notification at the current local receive time while reusing a much older `tt:Message UtcTime`.

Therefore:

**Never reject an ONVIF notification merely because its camera-supplied `UtcTime` is old, repeated, out of order, or otherwise implausible.**

Use:

```ts
Date.now()
```

for Scrypted event timestamps and any local deduplication/rearm logic.

Preserve the camera timestamp only for diagnostic logging.

This aligns well with existing Scrypted behavior: `plugins/onvif/src/onvif-events.ts` already timestamps `ObjectsDetected` with `Date.now()`.

## 1.5 Runtime Tapo schema is richer than GetEventProperties

The tested camera advertises topics including:

```text
RuleEngine/CellMotionDetector/Motion
    IsMotion

RuleEngine/TamperDetector/Tamper
    IsTamper

RuleEngine/IntrusionDetector/Intrusion
    IsIntrusion

RuleEngine/LineCrossDetector/LineCross
    IsLineCross

RuleEngine/PeopleDetector/People
    IsPeople

RuleEngine/TPSmartEventDetector/TPSmartEvent
    IsTPSmartEvent
```

However runtime capture also observed:

```text
RuleEngine/TPSmartEventDetector/TPSmartEvent
    IsVehicle
```

even though `IsVehicle` was **not declared** by the camera's `GetEventProperties` response.

Conclusion:

> Runtime `Notify` data is authoritative. `GetEventProperties` is useful for discovery but cannot be assumed to enumerate every vendor field.

Unknown vendor fields must be logged/retained rather than discarded.

---

# 2. Current upstream code to inspect before changing anything

Before implementation, sync the fork and inspect the current upstream versions of these files. Do not assume line numbers in this document are still current.

Primary files:

```text
plugins/onvif/src/onvif-api.ts
plugins/onvif/src/onvif-events.ts
plugins/onvif/src/main.ts
plugins/onvif/package.json
plugins/tapo/src/main.ts
```

As of this plan's research snapshot:

- `@scrypted/onvif` is version `0.1.31`.
- It depends on `onvif: ^0.7.4`.
- `OnvifCameraAPI.createSubscription()` calls `cam.createPullPointSubscription()`.
- `supportsEvents()` logs whether PullPoint is advertised but does not choose a different transport.
- `listenEvents()` consumes `cam.on('event')`.
- The parser currently assumes one `data.simpleItem.$`.
- `getEventTypes()` primarily inspects the standard `RuleEngine/ObjectDetector` tree.
- `onvif-events.ts` converts `OnvifEvent.Detection` into `ObjectsDetected` with `timestamp: Date.now()`.
- `main.ts` exposes Advanced camera settings and is the appropriate place for a transport selector.
- The Tapo plugin is a separate mixin and is not the owner of ONVIF event transport.

First command sequence:

```bash
git remote -v
git fetch upstream
git switch main
git pull --ff-only upstream main

git switch -c onvif-base-notification-push
```

If the fork uses a different default branch workflow, adapt without rewriting shared history.

Record the base commit:

```bash
git rev-parse HEAD
```

Include that SHA in development notes and eventually in the PR testing section.

---

# 3. Scope and non-goals

## In scope

### Generic ONVIF functionality

- PullPoint transport remains supported.
- Add WS-BaseNotification push transport.
- Add an Advanced per-camera event transport setting.
- Subscribe/Renew/Unsubscribe lifecycle.
- Scrypted-managed callback endpoint.
- Common notification normalization.
- Multiple `Source/SimpleItem` and `Data/SimpleItem` support.
- Safe boolean normalization.
- Diagnostic retention of camera timestamp.
- Runtime event logging suitable for troubleshooting.
- Cleanup/reconnect behavior.
- Automated unit tests.

### Tapo compatibility

- `PeopleDetector/People + IsPeople=true` -> `person`
- `TPSmartEventDetector/TPSmartEvent + IsVehicle=true` -> `vehicle`
- Existing `CellMotionDetector/Motion + IsMotion=true` -> motion
- Ignore `PropertyOperation="Initialized"` for user-notification style detection events.
- Do not use Tapo `UtcTime` to suppress events.
- Do not assume `GetEventProperties` is exhaustive.

## Out of scope for the first upstream PR

Do not mix these into the transport PR unless required for correctness:

- H500 reverse engineering.
- Pet detection not emitted by the camera.
- HomeKit Secure Video changes.
- Cloud/iCloud video analysis.
- A Tapo cloud API.
- Changes to Tapo two-way audio.
- Replacing working PullPoint behavior globally.
- A new custom TCP/HTTP server with a hard-coded port.
- Camera firmware-specific long subscription leases.
- Automatic transport switching based only on "no events for N minutes."

The last point is important: a camera can legitimately have no events because nothing happened. **Silence is not proof that PullPoint is broken.**

---

# 4. Recommended architecture

Use three layers:

```text
                        ONVIF Camera
                             |
                  +----------+----------+
                  |                     |
             PullPoint             Base Notification
                  |                   Push
                  |                     |
                  v                     v
          PullPoint adapter       Push adapter
                  |                     |
                  +----------+----------+
                             |
                             v
                 Notification normalizer
                             |
                  topic/source/data/op
                             |
                             v
                     Event classifier
                             |
            +----------------+----------------+
            |                                 |
         motion                        object detection
            |                           person/vehicle
            v                                 v
    MotionSensor state               ObjectDetector event
```

Transport code must not duplicate semantic parsing.

The same normalizer/classifier must consume notifications regardless of whether they arrived from PullPoint or HTTP Push.

---

# 5. Transport setting

Add an Advanced camera setting such as:

```text
ONVIF Event Transport
```

Values:

```text
Auto
PullPoint
Push
```

UI wording should preferably say:

```text
Auto
PullPoint
Push (WS-BaseNotification)
```

Suggested storage key:

```text
onvifEventTransport
```

Suggested stored values:

```text
auto
pullpoint
push
```

## Required behavior

### `PullPoint`

Use the current behavior.

### `Push`

Use Base Notification only.

### `Auto`

For the first safe/upstreamable implementation:

1. Prefer the existing PullPoint path when the camera advertises/supports it.
2. Fall back to Push on a concrete PullPoint setup/protocol failure.
3. Do **not** switch merely because no motion event was seen during a timer window.
4. Allow the user to explicitly select Push for cameras such as Tapo that accept PullPoint setup but do not deliver events.

This keeps default behavior backwards-compatible.

A later PR can add a carefully designed health check if a reliable protocol-level way to detect a "connected but inert" PullPoint is found.

Do not hard-code:

```ts
if (manufacturer === 'Tapo') usePush();
```

in the first generic transport PR.

It is acceptable to document that affected Tapo users should select Push.

---

# 6. Use Scrypted's HTTP endpoint infrastructure

Do not recreate the standalone prototype's custom HTTP server/port.

Scrypted provides:

- `HttpRequestHandler`
- `endpointManager.getLocalEndpoint(...)`

Implement the callback through Scrypted.

Recommended design:

1. Make the ONVIF **provider/plugin** implement `HttpRequestHandler`.
2. Add `HttpRequestHandler` to the plugin's declared interfaces in `plugins/onvif/package.json`.
3. Create one provider-level local HTTP endpoint.
4. Route individual camera subscriptions using a cryptographically random callback token.

Example conceptual URL:

```text
http://<scrypted-lan-address>:<managed-port>/endpoint/@scrypted/onvif/<random-token>
```

Do not manually assume Scrypted's port or endpoint prefix. Generate the endpoint using `endpointManager`.

Use:

```ts
endpointManager.getLocalEndpoint(undefined, {
    public: true,
    insecure: true,
});
```

or the current equivalent API after checking the SDK version in the fork.

Why:

- camera callbacks are machine-to-machine;
- many cameras cannot validate Scrypted's self-signed HTTPS certificate;
- the endpoint only needs LAN reachability;
- Scrypted manages the HTTP listener and routing.

## Callback security

Because this is a public local endpoint:

- Generate at least 128 bits of random token entropy.
- Use a unique token per active camera subscription/session.
- Accept only `POST`.
- Reject unknown tokens.
- Do not place camera username/password in the callback URL.
- Optionally validate source address against the configured camera IP, but do not make this mandatory if Scrypted's request abstraction does not expose a reliable peer address.
- Never log ONVIF credentials.
- Do not log raw SOAP by default.
- If raw SOAP debug logging is added, hide it behind an Advanced/debug option.

## Callback response

Return HTTP `200` quickly.

Prefer:

```ts
response.send('ok', {
    code: 200,
});
```

Then parse/dispatch the already-received request body with error isolation.

Do not make the camera wait for downstream Scrypted/HomeKit work.

Handle malformed XML without throwing out of `onRequest`.

Unknown/expired callback token:

```text
404 or 410
```

is reasonable.

---

# 7. Push subscription adapter

Create a transport abstraction rather than stuffing everything into `OnvifCameraAPI.listenEvents()`.

Suggested types:

```ts
type OnvifEventTransportMode = 'auto' | 'pullpoint' | 'push';

interface OnvifEventSubscription {
    destroy(): Promise<void> | void;
}
```

Possible files:

```text
plugins/onvif/src/onvif-event-transport.ts
plugins/onvif/src/onvif-event-normalizer.ts
```

or keep files smaller if upstream style favors fewer files.

## Push lifecycle

The tested lifecycle is:

```text
Subscribe
Renew
Renew
...
Unsubscribe on clean teardown
```

Use the npm `onvif` library's Base Notification operations where possible:

```js
cam.subscribe({ url }, callback)
cam.renew({}, callback)
cam.unsubscribe(callback)
```

The library stores the returned subscription manager reference in:

```text
cam.events.subscription
```

Do not run PullPoint and Push simultaneously on the same `Cam` instance because the library uses shared `cam.events.subscription` state.

## Renewal scheduling

Do not schedule from the camera's absolute wall-clock time.

Use the **relative lease duration**:

```text
TerminationTime - CurrentTime
```

then schedule against local `Date.now()`.

The `onvif` library itself has logic for converting a camera's response times into a locally useful termination time. Inspect the installed library version rather than copying master blindly.

The tested prototype renewed a 120-second lease around 78 seconds (~65%).

A reasonable implementation is:

```ts
renewDelay = leaseDuration * 0.65
```

with defensive minimum/maximum bounds.

The exact percentage is less important than:

- renew comfortably before expiration;
- derive it from the accepted lease;
- avoid dependence on camera timezone/clock accuracy.

On successful Renew:

- update the locally computed termination time;
- schedule the next Renew;
- log at debug/info level.

Example:

```text
ONVIF push subscription active; lease=120s; renew in 78s
ONVIF push subscription renewed; lease=120s; renew in 78s
```

## Renew failure

Use bounded retry/backoff before the known lease expires.

Do not create overlapping subscriptions as the first recovery action.

Suggested recovery:

1. Renew fails.
2. Retry with short bounded backoff if time remains.
3. If camera is offline/network error, reconnect normally.
4. Once the old lease is known expired or the camera connection was recreated, perform a fresh Subscribe.
5. Ensure only one active subscription lifecycle is owned by the camera instance.

All timers must be cancelled by `destroy()`.

`destroy()` must be idempotent.

---

# 8. Parse Push notifications safely

The upstream `onvif` library currently provides `parseEventXML`, but verify that the installed `^0.7.4` resolution exposes it before relying on it.

Preferred approach:

```ts
cam.parseEventXML(xml, callback)
```

if present and compatible.

Fallback:

- use the plugin's existing `xml2js` dependency;
- parse the standard WS-Notification `Notify` envelope directly.

Do not add another XML dependency unless necessary.

## Multiple notifications

A single POST may contain one or multiple:

```text
wsnt:NotificationMessage
```

Normalize singleton vs array.

## Multiple SimpleItems

The existing Scrypted parser currently assumes one:

```ts
event.message.message.data.simpleItem.$
```

Do not preserve that limitation.

Normalize all:

```text
tt:Source/tt:SimpleItem[]
tt:Data/tt:SimpleItem[]
```

into dictionaries or arrays.

Suggested normalized shape:

```ts
interface NormalizedOnvifNotification {
    topic: string;
    operation?: string;
    cameraUtcTime?: string;
    receivedAt: number;
    source: Record<string, string>;
    data: Record<string, string | boolean | number>;
    rawData: Record<string, string>;
}
```

`receivedAt` is always:

```ts
Date.now()
```

at callback/pull receipt.

## Boolean normalization

Do not use JavaScript truthiness on strings.

This is wrong:

```ts
if (dataValue) {
    // "false" is truthy
}
```

Normalize explicitly.

At minimum:

```text
true, "true", 1, "1"   -> true
false, "false", 0, "0" -> false
```

Do not coerce arbitrary nonboolean strings because some ONVIF topics legitimately carry values such as `"Ring"`.

Add tests for both boolean and nonboolean values.

---

# 9. Common notification classification

Refactor current parsing so PullPoint and Push both call the same function.

Conceptual flow:

```ts
handleNotification(notification, rawXml) {
    const normalized = normalizeNotification(notification);

    emit raw/onvifEvent diagnostics;

    classify motion/audio/binary/object events;

    emit OnvifEvent.*;
}
```

Do not duplicate the large topic `if/else` tree once for PullPoint and once for Push.

## Existing compatibility

Preserve current handling for:

- MotionAlarm
- DetectedSound
- Reolink Visitor
- Mobotix VideoSource/Alarm
- configured binary state event
- CellMotionDetector/Motion
- standard RuleEngine/ObjectDetector

Add tests before refactoring if necessary to prove existing behavior remains unchanged.

---

# 10. Tapo mappings

Add narrow, documented vendor-compatible mappings.

## Person

For:

```text
RuleEngine/PeopleDetector/People
```

when:

```text
IsPeople=true
```

emit:

```ts
OnvifEvent.Detection, 'person'
```

Do not emit a detection for:

```text
PropertyOperation="Initialized"
```

unless upstream Scrypted convention explicitly requires initialization events.

## Vehicle

For:

```text
RuleEngine/TPSmartEventDetector/TPSmartEvent
```

when runtime data contains:

```text
IsVehicle=true
```

emit:

```ts
OnvifEvent.Detection, 'vehicle'
```

Important comment to put near this code:

> Some Tapo firmware emits `IsVehicle` at runtime even when `GetEventProperties` declares only `IsTPSmartEvent`. Runtime `Notify` fields must therefore not be restricted to the advertised schema.

## Generic motion

Preserve:

```text
RuleEngine/CellMotionDetector/Motion
IsMotion=true
```

as motion.

## Unknown Tapo smart fields

Do not discard them silently.

For an unknown boolean data key such as:

```text
IsPet
IsAnimal
IsPackage
IsFoo
```

log it at debug level once per unique topic/property, or expose it through the raw `onvifEvent` diagnostic stream.

Do **not** automatically map every `IsFoo` to a Scrypted class.

Known mappings should be explicit.

---

# 11. Camera timestamps and duplicate bursts

## Camera time

Never use:

```text
tt:Message UtcTime
```

for:

- freshness rejection;
- stale rejection;
- event ordering;
- deduplication TTL;
- Scrypted `ObjectsDetected.timestamp`.

Use local receive time.

It is fine to log:

```text
cameraUtcTime=...
receivedAt=...
```

for diagnostics.

## Duplicate vendor detections

Tapo can emit multiple notifications for a single physical event, including repeated true/false packets and reused camera timestamps.

Do not solve this with camera timestamp comparison.

For the fork used on the live system, preserve the proven local-arrival burst suppression behavior if duplicate Home notifications occur.

However, be conservative in the generic upstream PR.

Recommended separation:

- transport PR: no camera-time-based filtering;
- parser PR/commit: normalize events correctly;
- Tapo compatibility mapping: if a short dedupe is required, scope it to Tapo-style object detection events or make it a small event-state helper rather than changing all ONVIF cameras globally.

A candidate key is:

```text
topic + property-name
```

and a local rearm/cooldown window around 10 seconds.

Before upstreaming a hard-coded cooldown, verify whether Scrypted downstream already suppresses repeated `ObjectDetector` events sufficiently.

Prefer the smallest behavior change compatible with correctness.

---

# 12. ObjectDetector discovery gotcha

`getEventTypes()` currently discovers standard ONVIF object classes mainly from:

```text
RuleEngine/ObjectDetector
```

Tapo does not use that standard tree for person detection, and `IsVehicle` may not be advertised at all.

Therefore simply emitting:

```ts
OnvifEvent.Detection
```

is not enough if the camera has not exposed the Scrypted `ObjectDetector` interface.

The agent must test this explicitly.

Possible implementation strategy:

1. Extend `getEventTypes()` to recognize an advertised Tapo-style `PeopleDetector/People` and add:
   ```text
   person
   ```
2. Do not claim `vehicle` solely from `GetEventProperties` if it is absent.
3. When a previously unknown runtime class such as `IsVehicle` is observed:
   - add it to the in-memory detection class set;
   - ensure the camera is marked as having `ObjectDetector`;
   - ask the owning `OnvifCamera`/provider to refresh interfaces if necessary.
4. Ensure `getObjectTypes()` then returns the discovered classes.

Do not simply expose `ObjectDetector` on every ONVIF camera.

Avoid device recreation or native ID changes.

---

# 13. HomeKit behavior and scope boundary

The native ONVIF plugin should provide correct Scrypted semantics:

```text
MotionSensor state
ObjectDetector(person)
ObjectDetector(vehicle)
```

The existing `onvif-events.ts` code already turns `OnvifEvent.Detection` into `ObjectsDetected`.

For the user's deployment, verify:

1. Live video remains unchanged.
2. `motionDetected` still toggles and produces normal Home activity notifications.
3. Person and vehicle are visible as Scrypted `ObjectDetector` events.
4. No iCloud/HKSV analysis is required to generate the local Scrypted events.

Do **not** assume Apple Home will display the native Scrypted object class as a "Person" or "Vehicle" camera notification when HKSV is disabled. That is a separate HomeKit presentation question.

If class-named Home notifications are still desired after native ObjectDetector integration, implement that as a separate optional layer/commit—for example virtual per-class motion sensors or a HomeKit-specific mapping—not inside the generic ONVIF transport PR.

The transport PR should not be blocked on Apple UI wording.

---

# 14. Callback networking gotchas

This feature reverses the connection direction.

PullPoint:

```text
Scrypted -> camera
```

Push:

```text
Scrypted -> camera (Subscribe)
camera -> Scrypted (Notify)
```

Therefore the camera must be able to reach the callback URL.

Before blaming ONVIF parsing, verify:

- callback URL resolves to the Scrypted server's LAN-reachable address;
- it is not `127.0.0.1`;
- it is not a Docker bridge-only address;
- it is not an unreachable IPv6/link-local address;
- camera VLAN/firewall permits camera -> Scrypted callback TCP traffic;
- Scrypted's Docker deployment uses the supported networking configuration;
- callback endpoint uses HTTP if the camera cannot trust Scrypted TLS.

Log the final callback URL at subscription startup.

Do not log authentication material.

## Multi-NIC / VLAN systems

`EndpointManager` may choose an address that is valid for Scrypted but unreachable from an isolated camera network.

First use Scrypted's recommended local address API.

Only add a manual callback-address override if real testing proves it is necessary.

If an override is added, make it Advanced and clearly document that the path/port should still be Scrypted-managed.

## Cluster installations

Treat cluster mode as a separate compatibility test.

A push callback must reach the node/process that owns the route.

Do not build raw socket listeners bound to arbitrary workers.

Using Scrypted `EndpointManager` is specifically intended to avoid this class of deployment problem, but verify it on a clustered installation if upstream maintainers request it.

---

# 15. Lifecycle and reload gotchas

Scrypted plugin development redeploys/reloads the plugin without restarting the whole server.

The implementation must survive this cleanly.

On plugin/camera event listener teardown:

- cancel Renew timer;
- remove callback token registration;
- best-effort `Unsubscribe`;
- remove event listeners;
- prevent retry callbacks from recreating subscriptions after destroy;
- make `destroy()` idempotent.

Use a generation/destroyed flag if asynchronous callbacks can race with teardown.

A late camera POST to an old callback token must be safely rejected and must not resurrect state.

Do not leave duplicate subscription timers running after a settings change.

Changing `ONVIF Event Transport` must force the existing event listener/subscription to restart.

Check how `RtspSmartCamera` currently restarts listeners after `putSetting`; integrate with that lifecycle rather than adding a parallel permanent loop.

---

# 16. Automated tests

The ONVIF plugin currently does not expose a dedicated `test` npm script in its `package.json`, so first inspect repository-wide testing conventions before adding a new framework.

Do not add Jest/Vitest/Mocha solely for this patch unless the repository already standardizes on it.

Prefer small pure functions that can be tested with the repository's existing tooling.

At minimum add tests/fixtures for the following.

## 16.1 Notification normalization

### Single SimpleItem

Input:

```xml
<Data>
  <SimpleItem Name="IsPeople" Value="true"/>
</Data>
```

Expected:

```ts
data.IsPeople === true
```

### Multiple SimpleItems

Input includes:

```xml
<SimpleItem Name="IsTPSmartEvent" Value="true"/>
<SimpleItem Name="IsVehicle" Value="true"/>
```

Both survive normalization.

### Boolean strings

Verify:

```text
"true"  -> true
"false" -> false
"1"     -> true
"0"     -> false
```

### Nonboolean strings

Verify:

```text
Value="Ring"
```

remains `"Ring"`.

### Singleton/array XML shapes

Test both because `xml2js`/library parsers often collapse singleton nodes differently.

## 16.2 Tapo person fixture

Topic:

```text
tns1:RuleEngine/PeopleDetector/People
```

Data:

```text
IsPeople=true
```

Expected:

```text
Detection(person)
```

## 16.3 Tapo vehicle fixture

Topic:

```text
tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent
```

Data:

```text
IsVehicle=true
```

Expected:

```text
Detection(vehicle)
```

Test that this works even when the advertised schema fixture contains only:

```text
IsTPSmartEvent
```

## 16.4 Initialized event

Input:

```text
PropertyOperation="Initialized"
IsPeople=true
```

Expected:

```text
no new person notification trigger
```

## 16.5 Stale/reused camera UtcTime

Two different callback receives:

```text
receivedAt T0
cameraUtcTime X

receivedAt T0 + 180s
cameraUtcTime X
```

The second event must **not** be rejected solely because the camera timestamp is identical.

## 16.6 PullPoint regression

Feed existing standard PullPoint notification shapes through the new common parser and confirm existing event classifications remain unchanged.

## 16.7 Push endpoint routing

Test:

- valid token + POST -> accepted;
- invalid token -> rejected;
- wrong method -> rejected;
- malformed XML -> HTTP handler survives;
- one POST containing multiple NotificationMessages -> all are dispatched.

## 16.8 Subscription timer

Use a fake clock or injected scheduler.

Given:

```text
CurrentTime      = 00:00:00
TerminationTime  = 00:02:00
```

verify Renew is scheduled before expiry, around the selected fraction.

Test destruction cancels the timer.

## 16.9 Renew error

Simulate:

- transient renew error then success;
- repeated error until expiry;
- camera reconnect/fresh subscribe;
- destroy during pending retry.

There must be no overlapping runaway timers.

---

# 17. Build validation

From repository root, install the monorepo dependencies using the upstream-supported workflow:

```bash
./npm-install.sh
```

Then:

```bash
cd plugins/onvif
npm run build
```

The current plugin scripts include:

```text
build
scrypted-deploy
scrypted-deploy-debug
scrypted-debug
```

Do not publish to npm during development.

Also run any repository typecheck/lint/test commands discovered while inspecting the current tree.

Record all exact commands and results for the PR.

---

# 18. Safe deployment to the running Scrypted server

The official Scrypted repository documents direct plugin deployment without restarting the Scrypted server.

From:

```text
plugins/onvif
```

use:

```bash
npm run build
npm run scrypted-deploy <SCRYPTED_HOST>
```

For example, replace `<SCRYPTED_HOST>` with the LAN hostname/IP of the running server.

If the deploy tool requests authentication, follow the Scrypted CLI login prompt (`npx scrypted login`) and retry.

## Before deployment

Record:

- current Scrypted server version;
- currently installed ONVIF plugin version;
- target camera model and firmware;
- current camera settings;
- current HomeKit live-stream status;
- existing ONVIF transport behavior;
- current git base SHA.

Do not rename the plugin package.

Keep:

```text
@scrypted/onvif
```

so the custom build upgrades the existing plugin instance rather than creating a second provider.

Do not delete/re-add the camera for the first test.

## Rollback preparation

Before deploying modified code, create a clean worktree or branch at the exact upstream base:

```bash
git worktree add ../scrypted-onvif-rollback <BASE_SHA>
```

Install/build dependencies there if needed.

Rollback path:

```bash
cd ../scrypted-onvif-rollback/plugins/onvif
npm run build
npm run scrypted-deploy <SCRYPTED_HOST>
```

Alternatively reinstall the official ONVIF plugin from Scrypted's management UI if that is known to restore the desired version.

Do not manually edit Scrypted's persistent volume as a rollback method.

---

# 19. Live test sequence

Perform tests in this order.

Do not start with HomeKit. First prove Scrypted receives and represents the events correctly.

## 19.1 PullPoint regression camera

If another known-good ONVIF camera is available:

1. Leave transport at `Auto`/PullPoint.
2. Trigger motion.
3. Verify current motion behavior still works.
4. Verify no callback subscription is created unnecessarily.

If no second camera exists, at least confirm the Tapo can still be set to PullPoint and that behavior matches the known pre-fix baseline.

## 19.2 Tapo Push startup

Set:

```text
ONVIF Event Transport = Push
```

Restart/reload the camera listener if necessary.

Expected logs:

```text
ONVIF push callback: http://<reachable-scrypted-address>/...
ONVIF push subscription active
lease approximately 120s
renew scheduled before expiry
```

The callback URL must be reachable from the camera network.

## 19.3 Generic motion

Trigger ordinary motion.

Expected:

```text
IsMotion=true
```

and:

```text
camera.motionDetected = true
```

Verify the Scrypted UI motion indicator.

## 19.4 Person

Trigger a person detection.

Expected raw/normalized data:

```text
topic=RuleEngine/PeopleDetector/People
IsPeople=true
```

Expected Scrypted object detection:

```text
className=person
timestamp=<local Date.now()>
```

The camera's `UtcTime` may be stale and must not suppress the event.

## 19.5 Vehicle

Trigger a vehicle detection.

Expected:

```text
topic=RuleEngine/TPSmartEventDetector/TPSmartEvent
IsVehicle=true
```

Expected:

```text
className=vehicle
```

This must work even though the camera may not advertise `IsVehicle` in `GetEventProperties`.

## 19.6 Renew cycles

This is mandatory.

Keep the listener running across at least **three Renew cycles**.

After each Renew:

1. trigger person;
2. trigger generic motion;
3. trigger vehicle if practical.

Confirm events continue.

Acceptance threshold:

```text
>= 3 successful Renew cycles
no event-listener restart
no duplicate subscription creation
fresh local receive timestamps
```

## 19.7 Camera reboot

With Push selected:

1. reboot/power-cycle camera;
2. observe Renew/subscription failure;
3. verify automatic recovery;
4. trigger motion/person after camera is back.

The listener must recover without restarting the whole Scrypted server.

## 19.8 Plugin redeploy/reload

Redeploy the plugin while a subscription exists.

Verify:

- old callback token becomes invalid;
- old timer stops;
- new subscription starts once;
- no duplicate event delivery;
- no server restart required.

## 19.9 HomeKit

After Scrypted-level tests pass:

1. verify live camera stream still opens;
2. trigger generic motion;
3. verify Home activity notification;
4. confirm no HKSV/iCloud video analysis is required for the local Scrypted motion event.

Then inspect person/vehicle visibility in Scrypted/HomeKit separately.

Document exactly what Apple Home displays.

Do not claim class-specific Apple notification wording unless directly observed.

---

# 20. Logging requirements

Useful normal logs:

```text
ONVIF event transport: push
ONVIF push callback: http://...
ONVIF push subscription active; lease=120s; renew in=78s
ONVIF push subscription renewed; lease=120s
ONVIF push reconnecting after error: ...
```

Useful debug logs:

```text
topic=RuleEngine/PeopleDetector/People
operation=Changed
data={"IsPeople":true}
cameraUtcTime=...
receivedAt=...
```

Avoid:

- logging username/password;
- Authorization headers;
- WS-Security credentials;
- raw SOAP on every event in normal mode.

For unknown vendor fields, log once per `(topic, property)` rather than spamming.

---

# 21. Failure modes the agent must explicitly consider

## Camera advertises PullPoint but PullPoint is inert

Manual Push setting solves this.

Do not rely on "no event for N minutes" automatic fallback.

## Camera cannot reach callback

Symptoms:

- Subscribe succeeds;
- no HTTP Notify arrives.

Check callback address/routing/firewall before changing parser logic.

## Camera clock/timezone is wrong

Do not care for event freshness.

Use local receive time.

## Camera sends `"false"` as a string

Do not use truthiness.

Normalize booleans.

## Camera sends multiple Data SimpleItems

Do not read only the first item.

## Camera sends a runtime field not in GetEventProperties

Do not reject it.

## Camera sends Initialized=true

Do not generate a user-facing object-detection notification from initialization.

## Renew succeeds but absolute times look wrong

Use returned relative lease duration.

## Plugin reload while async callbacks are pending

Use destroyed/generation checks.

## Multiple ONVIF cameras use Push

Every camera must have a unique callback token and isolated subscription state.

## PullPoint and Push accidentally share one `Cam.events.subscription`

Never run both at once for the same client instance.

## Upstream dependency changes

The package range is currently `onvif ^0.7.4`, while the library's current source may have changed.

Inspect the actual installed/resolved library before depending on undocumented internals.

Favor public methods:

```text
subscribe
renew
unsubscribe
parseEventXML
```

where available.

---

# 22. Commit strategy

Keep commits reviewable.

Suggested sequence:

## Commit 1

```text
onvif: normalize event notification payloads
```

- common notification parser;
- multiple SimpleItems;
- boolean normalization;
- tests;
- no behavior change intended for existing transports.

## Commit 2

```text
onvif: add WS-BaseNotification push transport
```

- provider HTTP endpoint;
- callback token routing;
- Subscribe/Renew/Unsubscribe;
- Advanced transport selector;
- teardown/reconnect;
- tests.

## Commit 3

```text
onvif: support Tapo person and vehicle events
```

- PeopleDetector;
- TPSmartEvent `IsVehicle`;
- runtime class discovery if needed;
- Initialized handling;
- tests/fixtures.

This commit structure permits upstream maintainers to accept generic transport/parser improvements even if they want vendor mappings revised or separated.

Avoid unrelated formatting changes.

Do not regenerate unrelated package files.

---

# 23. Upstream PR strategy

The strongest upstream story is not:

> "Add a Tapo hack."

It is:

> "Add ONVIF WS-BaseNotification push as an optional standards-based event transport, preserving PullPoint by default. This fixes devices that advertise PullPoint but only deliver reliable events via Base Notification, including current Tapo firmware."

Reference Scrypted issue:

```text
#1107 Adding optional support for ONVIF Motion Events using Webhooks
```

Use the standard term:

```text
WS-BaseNotification / Basic Notification Push
```

rather than only "webhook."

Issue #1107 already demonstrated this exact interoperability problem and suggested an optional toggle rather than replacing PullPoint.

---

# 24. Proposed PR title

```text
onvif: add WS-BaseNotification push event transport
```

If Tapo mappings are included:

```text
onvif: add push event transport and Tapo detection mappings
```

The first title is more likely to be viewed as a generic ONVIF improvement.

---

# 25. Proposed PR body

The agent should adapt this to the final diff and actual test results.

```markdown
## Summary

Adds an optional ONVIF WS-BaseNotification push event transport alongside the existing PullPoint implementation.

This addresses ONVIF devices that successfully advertise/create PullPoint subscriptions but do not deliver usable events through PullMessages. This behavior has been reproduced on TP-Link/Tapo firmware and was previously reported in #1107.

The default PullPoint behavior is preserved. A camera can explicitly select Push (WS-BaseNotification), and Auto only falls back on concrete PullPoint setup/protocol failure rather than event silence.

## Implementation

- Adds a Scrypted-managed local HTTP callback endpoint using `HttpRequestHandler`/`EndpointManager`.
- Uses the existing `onvif` library for Base Notification `Subscribe`, `Renew`, and `Unsubscribe`.
- Normalizes PullPoint and Push notifications through the same parser.
- Handles multiple ONVIF Source/Data `SimpleItem` entries.
- Normalizes boolean string values safely.
- Uses local receive time for Scrypted event timestamps rather than camera `UtcTime`.
- Preserves existing motion/audio/binary event handling.
- Adds Tapo person (`IsPeople`) and vehicle (`IsVehicle`) mappings if included in this PR.

## Why local receive time

Some tested Tapo firmware reuses an old `tt:Message UtcTime` for later live notifications. Treating that field as freshness/order metadata causes valid detections to be discarded. Scrypted's `ObjectsDetected` already uses `Date.now()`, so the new parser retains camera time only for diagnostics.

## Compatibility

Existing cameras remain on PullPoint by default/Auto unless Push is explicitly selected or PullPoint setup fails.

The Push callback is a local-only Scrypted endpoint with a random per-subscription token.

## Testing

Automated:
- [list exact test commands]
- single/multiple SimpleItem parsing
- boolean normalization
- standard PullPoint regression fixtures
- Push callback routing
- Renew scheduling/error recovery
- Tapo person/vehicle fixtures
- repeated/stale camera UtcTime fixture

Live:
- Scrypted server: [version]
- ONVIF plugin base: [version/SHA]
- Camera: [model/firmware]

Validated:
- generic motion
- person detection
- vehicle detection
- at least 3 Base Notification Renew cycles
- camera reboot/recovery
- plugin reload/redeploy
- existing HomeKit live streaming
- local Home motion notifications

## Related

Addresses #1107.
```

Do not write "Fixes #1107" unless the final implementation truly resolves the issue in the upstream maintainer's expected scope. "Addresses #1107" is safer initially.

---

# 26. PR evidence to attach

Keep evidence concise and scrubbed.

Useful:

```text
Camera advertises WSPullPointSupport=true
PullPoint subscription succeeds but produces no useful live events
Push Subscribe succeeds
Notify callback receives live IsPeople/IsMotion/IsVehicle
Renew succeeds across 3+ cycles
```

Include a short redacted event example.

Do **not** paste:

- camera credentials;
- Authorization headers;
- private webhook tokens;
- full internal configuration dumps.

Private RFC1918 IP addresses are usually low risk but can still be redacted for cleaner public reports.

---

# 27. Acceptance criteria

Do not consider the work complete until all of these are true.

## Code

- [ ] PullPoint path remains functional.
- [ ] Push path uses Scrypted EndpointManager.
- [ ] No hard-coded callback port.
- [ ] No separate standalone bridge required.
- [ ] Subscribe/Renew works continuously.
- [ ] Teardown cancels timers and unregisters callback.
- [ ] Common parser handles both transports.
- [ ] Multiple SimpleItems work.
- [ ] `"false"` is not treated as true.
- [ ] Camera UtcTime is not used for freshness rejection.
- [ ] Tapo person detection maps to `person`.
- [ ] Tapo vehicle detection maps to `vehicle`.
- [ ] Runtime undeclared fields are not discarded.

## Automated testing

- [ ] New parser tests pass.
- [ ] Transport tests pass.
- [ ] Existing build succeeds.
- [ ] Any repository lint/typecheck succeeds.
- [ ] PullPoint regression fixtures pass.

## Live Scrypted

- [ ] Custom ONVIF plugin deploys over existing plugin ID.
- [ ] Existing camera configuration is retained.
- [ ] Live streaming remains functional.
- [ ] Generic motion state works.
- [ ] Person detection appears in Scrypted.
- [ ] Vehicle detection appears in Scrypted.
- [ ] Three or more Renew cycles pass.
- [ ] Detection still works after each Renew.
- [ ] Camera reboot recovers.
- [ ] Plugin redeploy recovers.
- [ ] Home generic motion notification works without HKSV analysis.
- [ ] Rollback procedure has been tested or is ready.

## Upstream

- [ ] Branch rebased/merged cleanly from current upstream `main`.
- [ ] No unrelated diffs.
- [ ] Commit history is reviewable.
- [ ] PR references #1107.
- [ ] PR clearly states defaults are backward-compatible.
- [ ] Test hardware/firmware and test matrix are documented.
- [ ] No secrets are present in commits, logs, or PR text.

---

# 28. Research references

Use primary sources where possible and re-check them at implementation time because Scrypted evolves quickly.

## Scrypted

Scrypted repository and development/deploy instructions:

https://github.com/koush/scrypted

Current ONVIF API implementation:

https://github.com/koush/scrypted/blob/main/plugins/onvif/src/onvif-api.ts

Current ONVIF event-to-Scrypted adapter:

https://github.com/koush/scrypted/blob/main/plugins/onvif/src/onvif-events.ts

Current ONVIF camera/provider implementation:

https://github.com/koush/scrypted/blob/main/plugins/onvif/src/main.ts

Current ONVIF plugin package metadata:

https://github.com/koush/scrypted/blob/main/plugins/onvif/package.json

Current Tapo mixin:

https://github.com/koush/scrypted/blob/main/plugins/tapo/src/main.ts

Prior Scrypted issue demonstrating Tapo PullPoint failure and successful Base Notification callback:

https://github.com/koush/scrypted/issues/1107

Scrypted plugin development documentation:

https://developer.scrypted.app/plugins.html

Scrypted `EndpointManager`:

https://developer.scrypted.app/gen/interfaces/EndpointManager.html

Scrypted `HttpRequestHandler`:

https://developer.scrypted.app/gen/interfaces/HttpRequestHandler.html

Scrypted `HttpResponse` / response options:

https://developer.scrypted.app/gen/interfaces/HttpResponse.html

https://developer.scrypted.app/gen/interfaces/HttpResponseOptions.html

## Node ONVIF library

`agsh/onvif` event implementation, including Base Notification `subscribe`, `renew`, `unsubscribe`, PullPoint, and `parseEventXML`:

https://github.com/agsh/onvif/blob/master/lib/events.js

Important implementation detail: inspect the exact version resolved by the Scrypted lock/install rather than assuming current `master` behavior.

## ONVIF

ONVIF technical FAQ explaining that the ONVIF event mechanism is based on OASIS WS-BaseNotification:

https://developer.onvif.org/pub/info/Technical_FAQ.html

ONVIF device/event conformance test specifications:

https://www.onvif.org/profiles/conformance/device-test-2/

Use the current ONVIF Core/Event specifications if protocol details need to be resolved during implementation.

---

# 29. Final instruction to the implementation agent

Optimize first for:

1. backward compatibility;
2. clear transport separation;
3. standards-based naming and behavior;
4. deterministic cleanup/recovery;
5. evidence from actual camera traffic;
6. a small, reviewable upstream diff.

Do not "fix" ambiguous behavior by adding heuristics until it is reproduced.

If behavior differs from this document, capture the raw evidence, update the tests, and prefer observed protocol behavior over assumptions.

The standalone bridge work was a diagnostic prototype. The end state should be:

```text
Tapo / ONVIF camera
        |
        | WS-BaseNotification Notify
        v
@scrypted/onvif
        |
        +--> MotionSensor
        |
        +--> ObjectDetector(person/vehicle)
        |
        v
HomeKit / other Scrypted consumers
```

with no external webhook bridge required.
