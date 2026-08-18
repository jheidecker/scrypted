# ONVIF Base Notification Push — research

Supporting research for the `onvif-base-notification-push` work in `plugins/onvif`,
migrated 2026-08-18 from the standalone `tapo-onvif-push` bridge repo before that
repo was retired.

The bridge was a throwaway harness: it proved Tapo cameras emit usable
WS-BaseNotification push events and that a subscribe/renew cycle could drive
Scrypted webhooks. Once the behaviour was understood, the capability belonged in
the ONVIF plugin, not in a separate service.

| Document | Holds |
|---|---|
| `EVENT_DISCOVERY.md` | Which events Tapo cameras actually emit, and their shapes |
| `CAMERA_INSPECTION.md` | Camera capability and schema inspection findings |
| `REPRODUCTION.md` | Steps to reproduce the original behaviour |
| `UPSTREAM_ISSUE.md` | Issue write-up prepared for upstream |
| `UPSTREAM_PLAN.md` | Plan for landing this in the ONVIF plugin |

See `../SCRYPTED_ONVIF_PUSH_PR_DRAFT.md` for the PR text.
