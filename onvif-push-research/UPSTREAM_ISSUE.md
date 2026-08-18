# Draft: Scrypted upstream issue / PR context

## Title

ONVIF: add Base Notification push transport/fallback for cameras with broken PullPoint (confirmed Tapo)

## Problem

Current Tapo firmware can advertise `WSPullPointSupport=true` and allow Scrypted to create an ONVIF subscription, while PullPoint delivers no events. The same camera simultaneously delivers valid ONVIF Base Notification push events using `Subscribe` + `Notify`.

This reproduces the scenario described in Scrypted issue #1107, but was re-verified on current firmware in August 2026.

## Current Scrypted behavior

The ONVIF event path calls `supportsEvents()`, `createSubscription()`, then `listenEvents()`. On the affected camera, the subscription becomes active but no detection events arrive.

## Verified camera behavior

`GetEventProperties` advertises:

- `RuleEngine/CellMotionDetector/Motion` / `IsMotion`
- `RuleEngine/IntrusionDetector/Intrusion` / `IsIntrusion`
- `RuleEngine/LineCrossDetector/LineCross` / `IsLineCross`
- `RuleEngine/PeopleDetector/People` / `IsPeople`
- `RuleEngine/TPSmartEventDetector/TPSmartEvent` / `IsTPSmartEvent`

A Base Notification subscription to a LAN callback receives native people detections:

```
topic: tns1:RuleEngine/PeopleDetector/People
PropertyOperation: Changed
IsPeople: true
```

followed by:

```
PropertyOperation: Changed
IsPeople: false
```

The camera may reuse old or otherwise unreliable `tt:Message UtcTime` values for notifications received much later. Push handling must therefore treat camera `UtcTime` as diagnostic only and suppress duplicate detection bursts using local receipt time plus detector identity.

## Proposed implementation

Add an advanced ONVIF Event Transport setting:

- Auto
- PullPoint
- Base Notification Push

Push transport should:

1. expose a per-device callback endpoint reachable from the camera;
2. call ONVIF `Subscribe` with that callback;
3. `Renew` before the returned termination time;
4. `Unsubscribe` on teardown;
5. parse incoming `Notify` messages into the same normalized `OnvifEvent` pipeline used by PullPoint;
6. deduplicate repeated positive-event bursts using local receipt time rather than camera `UtcTime`;
7. preserve PullPoint as the default for cameras where it works.

This repository currently retests the stock `onvif` package lifecycle (`PT2M` Subscribe + `PT2M` Renew) with the corrected arrival-time deduper, because earlier apparent Renew failures were confounded by timestamp-based stale/expiry filtering.

A standalone reference implementation and reproducible fixtures are available in this repository.
