# Event discovery workflow

Use discovery mode before mapping Tapo event names to Scrypted/HomeKit classifications.

Discovery mode keeps the proven stock ONVIF Base Notification lifecycle (PT2M Subscribe + Renew), but it does not call the Scrypted webhook. It records every parsed ONVIF Data `SimpleItem`, regardless of `EVENT_NAMES`, and also retains every raw SOAP Notify envelope so vendor-specific structures are not lost.

## Start a clean capture

Use the same working camera and callback settings as normal. You do not need `SCRYPTED_WEBHOOK_URL` in discovery mode.

```bash
set -a
source .env
set +a
DISCOVERY_MODE=true npm start
```

The console prints the capture directory, for example:

```text
ONVIF discovery capture directory: /home/user/tapo-onvif-push/captures/2026-08-10T23-30-00-000Z
```

Each received property is also printed:

```text
DISCOVER topic=tns1:RuleEngine/PeopleDetector/People rule=MyPeopleDetectorRule property=IsPeople value=true op=Changed camera=... received=...
```

## Mark physical tests

In a second shell, use markers immediately before or after a deliberate test:

```bash
npm run capture:mark -- "generic movement: waved cardboard, no person"
npm run capture:mark -- "person entered from left"
npm run capture:mark -- "pet crossed center"
npm run capture:mark -- "vehicle crossed driveway"
npm run capture:mark -- "crossed configured line"
npm run capture:mark -- "entered intrusion zone"
```

Markers are timestamped using the host clock and stored in `markers.jsonl`. This is intentionally independent of Tapo's unreliable ONVIF `UtcTime`.

## Recommended test sequence

Enable every detection feature you actually plan to use in the Tapo app, then deliberately trigger them one at a time with at least 15 seconds of quiet between tests:

1. Generic motion without a visible person if possible (moving object, door, light change, etc.).
2. Person detection.
3. Pet/animal detection if the camera model offers it.
4. Vehicle detection if offered.
5. Line crossing.
6. Intrusion/zone detection.
7. Tamper detection if offered and safe to test.
8. Any model-specific smart detections (crying, glass break, baby, meow/bark, etc.) that the camera exposes.

Repeat each test twice. The first run discovers the event; the second helps distinguish stable fields from one-off state snapshots.

## Stop and review

Stop with Ctrl+C. The capture directory contains:

- `raw-notifications.jsonl` — every SOAP Notify envelope, losslessly retained as a JSON string.
- `events.jsonl` — normalized Data SimpleItems with topic, rule, property, value, operation, source fields, camera timestamp, and local receive timestamp.
- `markers.jsonl` — your manual physical-test markers.
- `summary.json` — machine-readable unique-event catalog.
- `summary.md` — human-readable unique-event catalog.

Print the catalog with:

```bash
cat captures/LATEST
npm run capture:report -- "$(cat captures/LATEST)"
```

## What to look for

Known examples include:

```text
tns1:RuleEngine/PeopleDetector/People
  IsPeople=true

tns1:RuleEngine/CellMotionDetector/Motion
  IsMotion=true
```

For Tapo smart detections, do not assume names. Look for additional topics, rules, or Data properties such as `IsTPSmartEvent`, `IsVehicle`, `IsPet`, `ObjectType`, or model-specific names. The raw SOAP capture is the source of truth if the normalized parser does not surface something useful.

## Important timestamp rule

Never use `tt:Message UtcTime` to correlate tests. Tapo firmware has been observed reusing old values. Use the local `receivedAt` timestamps and `markers.jsonl` instead.
