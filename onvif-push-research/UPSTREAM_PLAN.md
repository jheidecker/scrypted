# Upstream plan for Scrypted

The standalone bridge is a reference implementation and immediate workaround. The preferred long-term destination is Scrypted's ONVIF plugin.

## Proposed Scrypted behavior

Add an ONVIF Event Transport setting:

- `Auto` (default): use PullPoint normally; allow fallback to Base Notification push when PullPoint is known broken or remains silent while push is supported.
- `PullPoint`: current behavior.
- `Base Notification Push`: host a Scrypted HTTP callback endpoint and use ONVIF `Subscribe`, `Renew`, and `Unsubscribe`.

## Shared event pipeline

Both transports should normalize incoming ONVIF notifications into the existing `OnvifEvent` values so the rest of Scrypted remains unchanged.

For push transport:

1. Scrypted exposes a per-camera callback URL on a LAN-reachable interface.
2. `Subscribe` registers the callback.
3. `Renew` runs before the camera-provided termination time.
4. `Unsubscribe` runs on device/plugin shutdown.
5. Incoming notifications are parsed and routed through the same motion/object event mapping as PullPoint.
6. Treat Tapo `tt:Message UtcTime` as diagnostic only. Deduplicate repeated positive-event bursts by detector identity and local receipt time; do not reject a notification merely because the embedded camera timestamp is old or repeated.

## Why not replace PullPoint

Most cameras work correctly with PullPoint. Push should be an additional transport/fallback rather than a global replacement.

## Evidence to attach to an upstream issue/PR

- Camera `GetCapabilities`: `WSPullPointSupport=true`.
- Camera `GetEventProperties`: `Motion`, `People`, `Intrusion`, `LineCross`, and TP-Link smart-event topics.
- Scrypted log: subscription active, then no events.
- Push capture: `PeopleDetector/People`, `PropertyOperation=Changed`, `IsPeople=true` followed by `false`.
- Repeated/reused camera timestamps observed on later notifications, motivating local-arrival-time dedupe instead of timestamp ordering.
