# Camera schema inspection

`npm run inspect:camera` interrogates one ONVIF camera and saves the camera's own advertised schema alongside an optional runtime discovery capture.

The inspector is intentionally read-only. It queries:

- Device information
- Services
- Capabilities
- Media profiles (used to find `VideoAnalyticsConfiguration` tokens)
- Event `GetEventProperties`
- Analytics `GetServiceCapabilities`
- `GetSupportedRules` for every analytics configuration token
- `GetRules`
- `GetRuleOptions`
- `GetSupportedAnalyticsModules`
- `GetAnalyticsModules`
- `GetAnalyticsModuleOptions`
- `GetSupportedMetadata`

Not every camera implements every optional Analytics operation. Unsupported operations are recorded as `.error.txt` files and do not stop the inspection.

## Run

```bash
set -a
source .env
set +a
npm run inspect:camera
```

By default the inspector also reads the most recent `captures/LATEST/summary.json` and compares runtime events against `GetEventProperties`.

Specify a capture explicitly:

```bash
npm run inspect:camera -- --capture /path/to/capture/session
```

Or inspect the camera without runtime comparison:

```bash
npm run inspect:camera -- --no-capture
```

Use a different output base directory:

```bash
npm run inspect:camera -- --output ./my-inspections
```

## Output

The inspector creates `inspections/<timestamp>/` and updates `inspections/LATEST`.

Important files:

- `report.md`: human-readable schema/runtime comparison
- `report.json`: machine-readable report
- `event-properties.xml`: the event schema advertised by the camera
- `supported-rules-*.xml`: supported analytics rules per configuration token
- `rule-options-*.xml`: supported rule options/classes when implemented
- `supported-metadata.xml`: sample analytics metadata when implemented
- `*.error.txt`: SOAP faults or unsupported operations

A Tapo firmware discrepancy will be highlighted like:

```text
Runtime topic: tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent
Property: IsVehicle
Schema status: undeclared
```

That means the runtime `Notify` payload contains a property the camera did not declare in `GetEventProperties`. For Tapo vendor extensions, retain both the raw runtime capture and the inspection output rather than assuming the advertised schema is complete.
