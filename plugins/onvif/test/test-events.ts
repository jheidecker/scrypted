// Driver script for the onvif event parser. Run with:
//
//     npm test
//
// This exercises OnvifCameraAPI's notification classifier directly, so it does not require a
// camera or a running Scrypted server.

import assert from 'assert';
import { EventEmitter } from 'events';
import { OnvifCameraAPI, OnvifEvent, stripNamespaces } from '../src/onvif-api';

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

    console.log();
    console.log(`${passed} passed, ${failed} failed`);
    if (failed)
        process.exitCode = 1;
}

main();
