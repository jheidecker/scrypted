# Reproduction: Tapo push events with stock PT2M renewal

This experiment tests whether the stock `onvif` Base Notification lifecycle works once Tapo's embedded event timestamps are no longer used for deduplication.

## Known observations

- PullPoint subscriptions are accepted by the camera but Scrypted receives no useful events.
- Base Notification `Subscribe` delivers native Tapo ONVIF events such as `PeopleDetector/People` / `IsPeople`.
- Tapo may replay or reuse the same `tt:Message UtcTime` value for notifications received minutes later.
- Therefore `UtcTime` must not be used as a freshness or ordering source.

## Test

1. Reboot/power-cycle the camera to start from a clean event-service state.
2. Do not patch `node_modules/onvif`; use its stock `PT2M` Subscribe and Renew behavior.
3. Run the bridge and confirm a detection before the first Renew.
4. Wait for `ONVIF push subscription renewed.`
5. Trigger a detection after Renew.
6. Repeat across several renewal cycles.

A successful test is a Scrypted/Home notification after multiple Renew cycles, even if the camera's logged `UtcTime` remains old or repeated.
