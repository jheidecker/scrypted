// Driver script for the onvif event parser. Run with:
//
//     npm test
//
// This exercises OnvifCameraAPI's notification classifier directly, so it does not require a
// camera or a running Scrypted server.

import assert from 'assert';
import { EventEmitter } from 'events';
import { OnvifCameraAPI, OnvifEvent, stripNamespaces } from '../src/onvif-api';

const { Cam } = require('onvif');

let passed = 0;
let failed = 0;

function test(name: string, block: () => void | Promise<void>) {
    return Promise.resolve()
        .then(block)
        .then(() => {
            passed++;
            console.log('ok  -', name);
        })
        .catch(e => {
            failed++;
            console.log('FAIL-', name);
            console.log('     ', e.message);
        });
}

const quietConsole = {
    log() { },
    warn() { },
    error() { },
} as any as Console;

function createClient(binaryStateEvent?: string) {
    const cam = new EventEmitter() as any;
    cam.events = {};
    // borrowed from the real library so the push path is exercised against the actual SOAP
    // parser and its linerase coercions.
    cam.parseEventXML = Cam.prototype.parseEventXML;
    const client = new OnvifCameraAPI(cam, 'user', 'pass', quietConsole, binaryStateEvent);
    const events: { event: OnvifEvent, className?: string }[] = [];
    const onvifEvents: { topic: string, value: any }[] = [];
    const data: string[] = [];
    const ret = new EventEmitter();
    ret.on('event', (event, className) => events.push({ event, className }));
    ret.on('onvifEvent', (topic, value) => onvifEvents.push({ topic, value }));
    ret.on('data', xml => data.push(xml));
    return { cam, client, ret, events, onvifEvents, data };
}

/**
 * Mirrors the shape the onvif library emits for a notification message. linerase collapses a
 * single SimpleItem into an object and leaves several as an array, so both shapes are produced
 * here to cover the normalization.
 */
function notification(options: {
    topic: string,
    data: [string, any][],
    propertyOperation?: string,
}) {
    const items = options.data.map(([Name, Value]) => ({ $: { Name, Value } }));
    return {
        topic: { _: options.topic },
        message: {
            message: {
                $: {
                    UtcTime: new Date(),
                    PropertyOperation: options.propertyOperation ?? 'Changed',
                },
                data: { simpleItem: items.length === 1 ? items[0] : items },
            },
        },
    };
}

/**
 * Builds a WS-BaseNotification Notify envelope as a camera would POST it to the callback.
 */
function notifyXml(options: {
    topic: string,
    data: [string, string][],
    utcTime?: string,
    propertyOperation?: string,
    messages?: number,
}) {
    const { topic, data, utcTime = '2020-01-01T00:00:00Z', propertyOperation = 'Changed' } = options;
    const simpleItems = data.map(([name, value]) => `<tt:SimpleItem Name="${name}" Value="${value}"/>`).join('');

    const message = `
    <wsnt:NotificationMessage>
      <wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">${topic}</wsnt:Topic>
      <wsnt:Message>
        <tt:Message UtcTime="${utcTime}" PropertyOperation="${propertyOperation}">
          <tt:Source/>
          <tt:Data>${simpleItems}</tt:Data>
        </tt:Message>
      </wsnt:Message>
    </wsnt:NotificationMessage>`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
  xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"
  xmlns:tt="http://www.onvif.org/ver10/schema">
  <SOAP-ENV:Body>
    <wsnt:Notify>${message.repeat(options.messages ?? 1)}</wsnt:Notify>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

async function main() {
    await test('stripNamespaces removes per segment namespaces', () => {
        assert.strictEqual(
            stripNamespaces('tns1:MediaControl/tnsavg:ConfigurationUpdateAudioEncCfg'),
            'MediaControl/ConfigurationUpdateAudioEncCfg');
    });

    await test('a single SimpleItem is classified', () => {
        const { client, ret, events } = createClient();
        client.detections = new Map([['IsPerson', 'person']]);
        client.handleNotification(ret, notification({
            topic: 'tns1:RuleEngine/ObjectDetector/Person',
            data: [['IsPerson', true]],
        }), '<xml/>');
        assert.deepStrictEqual(events, [{ event: OnvifEvent.Detection, className: 'person' }]);
    });

    await test('multiple SimpleItems all survive normalization', () => {
        const { client, ret, events } = createClient();
        client.detections = new Map([['IsPerson', 'person'], ['IsVehicle', 'vehicle']]);
        client.handleNotification(ret, notification({
            topic: 'tns1:RuleEngine/ObjectDetector/Object',
            data: [['IsPerson', true], ['IsVehicle', true]],
        }), '<xml/>');
        // the previous parser only ever read the first SimpleItem.
        assert.deepStrictEqual(events.map(e => e.className), ['person', 'vehicle']);
    });

    await test('false is not treated as true', () => {
        const { client, ret, events } = createClient();
        client.detections = new Map([['IsPerson', 'person']]);
        client.handleNotification(ret, notification({
            topic: 'tns1:RuleEngine/ObjectDetector/Person',
            data: [['IsPerson', false]],
        }), '<xml/>');
        assert.deepStrictEqual(events, []);
    });

    await test('1 and 0 are accepted as xs:boolean', () => {
        for (const [value, expected] of [[1, [OnvifEvent.MotionBuggy]], [0, []]] as [number, OnvifEvent[]][]) {
            const { client, ret, events } = createClient();
            client.handleNotification(ret, notification({
                topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
                data: [['IsMotion', value]],
            }), '<xml/>');
            assert.deepStrictEqual(events.map(e => e.event), expected, `IsMotion=${value} misclassified`);
        }
    });

    await test('a non boolean value is never coerced to true', () => {
        const { client, ret, events, onvifEvents } = createClient();
        client.handleNotification(ret, notification({
            topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
            data: [['IsMotion', 'Ring']],
        }), '<xml/>');
        assert.strictEqual(onvifEvents[0].value, 'Ring', 'a non boolean value must be preserved');
        assert.deepStrictEqual(events, []);
    });

    await test('Initialized does not raise a detection', () => {
        const { client, ret, events } = createClient();
        client.detections = new Map([['IsPerson', 'person']]);
        client.handleNotification(ret, notification({
            topic: 'tns1:RuleEngine/ObjectDetector/Person',
            data: [['IsPerson', true]],
            propertyOperation: 'Initialized',
        }), '<xml/>');
        assert.deepStrictEqual(events, []);
    });

    await test('a malformed notification does not throw', () => {
        const { client, ret, events } = createClient();
        for (const bad of [{}, { topic: {} }, { message: {} }, { topic: { _: 'x' }, message: { message: {} } }]) {
            client.handleNotification(ret, bad, '<xml/>');
        }
        assert.deepStrictEqual(events, []);
    });

    await test('every notification emits data to keep the listen loop watchdog alive', () => {
        const { client, ret, data } = createClient();
        client.handleNotification(ret, notification({
            topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
            data: [['IsMotion', true]],
        }), '<raw/>');
        assert.deepStrictEqual(data, ['<raw/>']);
    });

    await test('existing classifications are unchanged', () => {
        const cases: { name: string, topic: string, data: [string, any][], expect: OnvifEvent[], binaryStateEvent?: string }[] = [
            { name: 'MotionAlarm start', topic: 'tns1:VideoSource/MotionAlarm', data: [['State', true]], expect: [OnvifEvent.MotionStart] },
            { name: 'MotionAlarm stop', topic: 'tns1:VideoSource/MotionAlarm', data: [['State', false]], expect: [OnvifEvent.MotionStop] },
            { name: 'DetectedSound start', topic: 'tns1:AudioAnalytics/Audio/DetectedSound', data: [['State', true]], expect: [OnvifEvent.AudioStart] },
            { name: 'DetectedSound stop', topic: 'tns1:AudioAnalytics/Audio/DetectedSound', data: [['State', false]], expect: [OnvifEvent.AudioStop] },
            { name: 'reolink visitor', topic: 'tns1:RuleEngine/MyRuleDetector/Visitor', data: [['State', true]], expect: [OnvifEvent.BinaryStart] },
            { name: 'mobotix ring', topic: 'tns1:VideoSource/Alarm', data: [['State', 'Ring']], expect: [OnvifEvent.BinaryRingEvent] },
            { name: 'mobotix bell button', topic: 'tns1:VideoSource/Alarm', data: [['State', 'CameraBellButton']], expect: [OnvifEvent.BinaryRingEvent] },
            { name: 'configured binary event', topic: 'tns1:RuleEngine/MyDoorbell', data: [['State', true]], expect: [OnvifEvent.BinaryStart], binaryStateEvent: 'MyDoorbell' },
            { name: 'cell motion', topic: 'tns1:RuleEngine/CellMotionDetector/Motion', data: [['IsMotion', true]], expect: [OnvifEvent.MotionBuggy] },
            { name: 'cell motion false', topic: 'tns1:RuleEngine/CellMotionDetector/Motion', data: [['IsMotion', false]], expect: [] },
        ];

        for (const c of cases) {
            const { client, ret, events } = createClient(c.binaryStateEvent);
            client.detections = new Map();
            client.handleNotification(ret, notification({ topic: c.topic, data: c.data }), '<xml/>');
            assert.deepStrictEqual(events.map(e => e.event), c.expect, `${c.name} changed classification`);
        }
    });

    await test('an unmapped detection name does not emit an undefined class', () => {
        const { client, ret, events } = createClient();
        client.detections = new Map();
        client.handleNotification(ret, notification({
            topic: 'tns1:RuleEngine/ObjectDetector/Mystery',
            data: [['IsMystery', true]],
        }), '<xml/>');
        assert.deepStrictEqual(events, []);
    });

    await test('getEventTypes claims person and vehicle from the advertised Tapo rules', async () => {
        const { cam, client } = createClient();
        // keys as the onvif tag name processor produces them: it lower cases the first letter
        // only when the second is lower case, so TPSmartEventDetector keeps its capital.
        cam.getEventProperties = (cb: any) => cb(null, {
            topicSet: {
                ruleEngine: {
                    cellMotionDetector: {},
                    peopleDetector: {},
                    TPSmartEventDetector: {},
                },
            },
        }, '<xml/>');
        const classes = await client.getEventTypes();
        assert.deepStrictEqual([...classes].sort(), ['person', 'vehicle']);
    });

    await test('getEventTypes claims nothing for a camera without the Tapo rules', async () => {
        const { cam, client } = createClient();
        cam.getEventProperties = (cb: any) => cb(null, {
            topicSet: { ruleEngine: { cellMotionDetector: {} } },
        }, '<xml/>');
        assert.deepStrictEqual(await client.getEventTypes(), []);
    });

    // ---- push transport ------------------------------------------------------------------

    await test('a pushed Notify is classified identically to a pulled one', async () => {
        const push = createClient();
        push.client.detections = new Map();
        await push.client.handlePushXml(push.ret, notifyXml({
            topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
            data: [['IsMotion', 'true']],
        }));

        const pull = createClient();
        pull.client.detections = new Map();
        pull.client.handleNotification(pull.ret, notification({
            topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
            data: [['IsMotion', true]],
        }), '<xml/>');

        assert.deepStrictEqual(push.events, pull.events);
    });

    await test('a pushed "false" is not treated as true', async () => {
        const { client, ret, events, onvifEvents } = createClient();
        await client.handlePushXml(ret, notifyXml({
            topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
            data: [['IsMotion', 'false']],
        }));
        assert.strictEqual(onvifEvents[0].value, false);
        assert.deepStrictEqual(events, []);
    });

    await test('a pushed multi SimpleItem message keeps every value', async () => {
        const { client, ret, events } = createClient();
        client.detections = new Map([['IsPerson', 'person'], ['IsVehicle', 'vehicle']]);
        await client.handlePushXml(ret, notifyXml({
            topic: 'tns1:RuleEngine/ObjectDetector/Object',
            data: [['IsPerson', 'true'], ['IsVehicle', 'true']],
        }));
        assert.deepStrictEqual(events.map(e => e.className), ['person', 'vehicle']);
    });

    await test('one POST containing multiple NotificationMessages dispatches all of them', async () => {
        const { client, ret, events } = createClient();
        client.detections = new Map([['IsPerson', 'person']]);
        await client.handlePushXml(ret, notifyXml({
            topic: 'tns1:RuleEngine/ObjectDetector/Person',
            data: [['IsPerson', 'true']],
            messages: 3,
        }));
        assert.strictEqual(events.length, 3);
    });

    await test('a malformed push body does not throw', async () => {
        const { client, ret, events } = createClient();
        for (const bad of ['this is not xml', '<html><body>nope</body></html>', '', '{}'])
            await client.handlePushXml(ret, bad);
        assert.deepStrictEqual(events, []);
    });

    await test('a repeated stale camera UtcTime does not suppress the second event', async () => {
        const { client, ret, events } = createClient();
        client.detections = new Map([['IsPerson', 'person']]);
        // deliberately old, and identical across both receives.
        const xml = notifyXml({
            topic: 'tns1:RuleEngine/ObjectDetector/Person',
            data: [['IsPerson', 'true']],
            utcTime: '2019-05-05T01:02:03Z',
        });
        await client.handlePushXml(ret, xml);
        await client.handlePushXml(ret, xml);
        assert.strictEqual(events.length, 2, 'the camera timestamp must not be used for freshness');
    });

    await test('the lease is derived from the relative termination time, not the camera clock', async () => {
        const { cam, client } = createClient();
        // a camera whose clock is years off still yields a two minute lease.
        cam.subscribe = (options: any, cb: any) => cb(null, {
            currentTime: new Date('2019-01-01T00:00:00Z'),
            terminationTime: new Date('2019-01-01T00:02:00Z'),
        });
        assert.strictEqual(await client.pushSubscribe('http://localhost/callback'), 120000);
        const remaining = cam.events.terminationTime.getTime() - Date.now();
        assert.ok(remaining > 118000 && remaining <= 120000, `termination time should be local, got ${remaining}ms`);
    });

    await test('a missing or nonsensical termination time falls back to the requested PT2M', async () => {
        for (const response of [{}, { currentTime: new Date(), terminationTime: new Date(Date.now() - 1000) }]) {
            const { cam, client } = createClient();
            cam.renew = (options: any, cb: any) => cb(null, response);
            assert.strictEqual(await client.pushRenew(), 120000);
        }
    });

    await test('renew failure propagates so the subscription can be replaced', async () => {
        const { cam, client } = createClient();
        cam.renew = (options: any, cb: any) => cb(new Error('renew rejected'));
        await assert.rejects(() => client.pushRenew(), /renew rejected/);
    });

    await test('a fresh subscribe still works after renew has been rejected', async () => {
        // a camera that has restarted no longer knows the subscription and answers Renew with
        // a SOAP fault, while still honouring Subscribe. the transport replaces the
        // subscription rather than retrying a renewal that cannot succeed.
        const { cam, client } = createClient();
        cam.renew = (options: any, cb: any) => cb(new Error('ONVIF SOAP Fault: error'));
        let unsubscribed = false;
        cam.unsubscribe = (cb: any) => { unsubscribed = true; cb(null, {}); };
        cam.subscribe = (options: any, cb: any) => cb(null, {
            currentTime: new Date('2020-01-01T00:00:00Z'),
            terminationTime: new Date('2020-01-01T00:02:00Z'),
        });

        await assert.rejects(() => client.pushRenew());
        await client.unsubscribe();
        assert.ok(unsubscribed, 'the stale subscription should be dropped before replacing it');
        assert.strictEqual(await client.pushSubscribe('http://localhost/callback'), 120000);
    });

    // ---- tapo ----------------------------------------------------------------------------

    await test('tapo person maps to person', async () => {
        const { client, ret, events } = createClient();
        client.detections = new Map();
        await client.handlePushXml(ret, notifyXml({
            topic: 'tns1:RuleEngine/PeopleDetector/People',
            data: [['IsPeople', 'true']],
        }));
        assert.deepStrictEqual(events, [{ event: OnvifEvent.Detection, className: 'person' }]);
    });

    await test('tapo person ignores IsPeople false', async () => {
        const { client, ret, events } = createClient();
        client.detections = new Map();
        await client.handlePushXml(ret, notifyXml({
            topic: 'tns1:RuleEngine/PeopleDetector/People',
            data: [['IsPeople', 'false']],
        }));
        assert.deepStrictEqual(events, []);
    });

    await test('tapo vehicle maps to vehicle even when the advertised schema omits IsVehicle', async () => {
        const { client, ret, events } = createClient();
        // the schema as GetEventProperties would have reported it: IsTPSmartEvent only.
        client.detections = new Map([['IsTPSmartEvent', 'motion']]);
        await client.handlePushXml(ret, notifyXml({
            topic: 'tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent',
            data: [['IsTPSmartEvent', 'true'], ['IsVehicle', 'true']],
        }));
        assert.deepStrictEqual(events, [{ event: OnvifEvent.Detection, className: 'vehicle' }]);
    });

    await test('an Initialized tapo detection does not notify', async () => {
        for (const [topic, name] of [
            ['tns1:RuleEngine/PeopleDetector/People', 'IsPeople'],
            ['tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent', 'IsVehicle'],
        ]) {
            const { client, ret, events } = createClient();
            client.detections = new Map();
            await client.handlePushXml(ret, notifyXml({
                topic,
                data: [[name, 'true']],
                propertyOperation: 'Initialized',
            }));
            assert.deepStrictEqual(events, [], `${topic} raised an Initialized detection`);
        }
    });

    await test('an unknown tapo smart field is not mapped to a class', async () => {
        const { client, ret, events } = createClient();
        client.detections = new Map();
        await client.handlePushXml(ret, notifyXml({
            topic: 'tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent',
            data: [['IsPet', 'true']],
        }));
        assert.deepStrictEqual(events, []);
    });

    await test('tapo cell motion is still generic motion', async () => {
        const { client, ret, events } = createClient();
        client.detections = new Map();
        await client.handlePushXml(ret, notifyXml({
            topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
            data: [['IsMotion', 'true']],
        }));
        assert.deepStrictEqual(events, [{ event: OnvifEvent.MotionBuggy, className: undefined }]);
    });

    console.log();
    console.log(`${passed} passed, ${failed} failed`);
    if (failed)
        process.exitCode = 1;
}

main();
