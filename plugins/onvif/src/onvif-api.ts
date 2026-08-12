import { AuthFetchCredentialState, authHttpFetch, HttpFetchOptions } from '@scrypted/common/src/http-auth-fetch';
import { VideoStreamConfiguration } from '@scrypted/sdk';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

const onvif = require('onvif');
const { Cam } = onvif;

export enum OnvifEvent {
    // some onvif cameras spam motion events with IsMotion value as false.
    // just use a timeout based approach.
    MotionBuggy,
    MotionStart,
    MotionStop,
    AudioStart,
    AudioStop,
    BinaryStart,
    BinaryStop,
    CellMotion,
    Detection,
    BinaryRingEvent,
    DigitalInputStart,
    DigitalInputStop,
}

export function stripNamespaces(topic: string) {
    // example input :-   tns1:MediaControl/tnsavg:ConfigurationUpdateAudioEncCfg 
    // Split on '/'
    // For each part, remove any namespace
    // Recombine parts that were split with '/'
    let output = '';
    let parts = topic.split('/')
    for (let index = 0; index < parts.length; index++) {
        let stringNoNamespace = parts[index].split(':').pop() // split on :, then return the last item in the array
        if (output.length === 0) {
            output += stringNoNamespace
        } else {
            output += '/' + stringNoNamespace
        }
    }
    return output
}

// the onvif library always requests a PT2M lease for both Subscribe and Renew.
const DEFAULT_LEASE_MS = 120000;

/**
 * The TPSmartEvent rule declares only IsTPSmartEvent, but carries these at runtime. Scrypted's
 * own vocabulary is used for the class rather than the vendor's, so a single consumer can match
 * detections from this camera and from a detection model.
 */
const TPSMART_DETECTION_CLASSES: Record<string, string> = {
    IsVehicle: 'vehicle',
    IsPet: 'animal',
};

function ensureArray<T>(value: T | T[]): T[] {
    if (value === undefined || value === null)
        return [];
    return Array.isArray(value) ? value : [value];
}

/**
 * ONVIF xs:boolean permits "true"/"false" as well as "1"/"0", which linerase turns into booleans
 * and numbers respectively. Values that are neither, such as the Mobotix "Ring", are not booleans
 * and must not be coerced.
 */
function isTrue(value: any) {
    return value === true || value === 1;
}

/**
 * An ONVIF tt:Source or tt:Data node may contain multiple tt:SimpleItem entries. The onvif
 * library's linerase collapses a single entry into an object and multiple entries into an
 * array, so normalize both shapes into a name/value dictionary.
 *
 * linerase has already coerced the attribute values, so "true"/"false" arrive as booleans and
 * numeric strings arrive as numbers.
 */
function normalizeSimpleItems(node: any) {
    const items = ensureArray(node?.simpleItem).filter((item: any) => item?.$?.Name !== undefined);
    const values: Record<string, any> = {};
    for (const item of items)
        values[item.$.Name] = item.$.Value;
    return { items, values };
}

async function promisify<T>(block: (callback: (err: Error, value: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
        block((err, value) => {
            if (err) return reject(err);
            resolve(value);
        });
    })
}

export class OnvifCameraAPI {
    snapshotUrls = new Map<string, string>();
    rtspUrls = new Map<string, string>();
    profiles: Promise<any>;
    binaryStateEvent: string;
    credential: AuthFetchCredentialState;
    detections: Map<string, string>;
    loggedUnknownProperties = new Set<string>();
    /**
     * When set, every notification is logged in normalized form. Intended for discovering the
     * topics and properties a camera actually reports, which is not always what it advertised.
     */
    debugEvents = false;
    /**
     * Optional sink for the normalized debug records, so the owning device can persist them
     * without pulling filesystem access into the shared event code.
     */
    onDebugEvent: (record: any) => void;

    constructor(public cam: any, username: string, password: string, public console: Console, binaryStateEvent: string) {
        this.binaryStateEvent = binaryStateEvent
        this.credential = {
            username,
            password,
        };
    }

    async request(urlOrOptions: string | URL | HttpFetchOptions<Readable>, body?: Readable) {
        const response = await authHttpFetch({
            ...typeof urlOrOptions !== 'string' && !(urlOrOptions instanceof URL) ? urlOrOptions : {
                url: urlOrOptions,
            },
            rejectUnauthorized: false,
            credential: this.credential,
            body,
        });
        return response;
    }

    async reboot() {
        return new Promise((resolve, reject) => {
            this.cam.systemReboot((err: Error, data: any, xml: string) => {
                if (err) {
                    this.console.log('reboot error', err);
                    return reject(err);
                }

                resolve(data as string);
            });
        })
    }

    listenEvents() {
        const ret = new EventEmitter();

        this.cam.on('event', (event: any, xml: string) => this.handleNotification(ret, event, xml));
        return ret;
    }

    /**
     * Creates the event emitter for the WS-BaseNotification push transport.
     *
     * Unlike listenEvents, this deliberately does not add an 'event' listener to the camera:
     * the onvif library starts a PullPoint subscription as soon as the first one is added, and
     * PullPoint and Base Notification share the same cam.events.subscription state. Only one of
     * the two transports may be active on a given client.
     */
    listenPushEvents() {
        return new EventEmitter();
    }

    /**
     * Parses the body of a Notify message posted by the camera and dispatches it through the
     * same classifier as PullPoint. A single POST may carry multiple NotificationMessages.
     */
    async handlePushXml(ret: EventEmitter, xml: string) {
        let messages: any[];
        try {
            // parseEventXML throws rather than reporting an error for a body that is not a
            // well formed Notify envelope.
            messages = ensureArray(await promisify<any>(cb => this.cam.parseEventXML(xml, cb)));
        }
        catch (e) {
            this.console.warn('error parsing onvif push notification', e);
            return;
        }

        for (const message of messages) {
            try {
                this.handleNotification(ret, message, xml);
            }
            catch (e) {
                this.console.warn('error handling onvif push notification', e);
            }
        }
    }

    /**
     * Creates a WS-BaseNotification subscription. The camera will POST Notify messages to the
     * supplied consumer url. Returns the accepted lease duration in milliseconds.
     */
    async pushSubscribe(url: string): Promise<number> {
        const subscription = await promisify<any>(cb => this.cam.subscribe({ url }, cb));
        return this.updateTerminationTime(subscription);
    }

    /**
     * Renews the current subscription. The onvif library always requests PT2M and does not
     * store the response, so the termination time is recomputed and assigned here.
     */
    async pushRenew(): Promise<number> {
        const renewal = await promisify<any>(cb => this.cam.renew({}, cb));
        return this.updateTerminationTime(renewal);
    }

    /**
     * Returns the accepted lease duration in milliseconds. The camera's absolute clock is not
     * trusted: only the relative difference between the current and termination time it reports
     * is used, and that duration is applied to the local clock.
     */
    updateTerminationTime(response: any) {
        let lease = DEFAULT_LEASE_MS;
        const currentTime = response?.currentTime?.getTime?.();
        const terminationTime = response?.terminationTime?.getTime?.();
        if (currentTime !== undefined && terminationTime !== undefined && terminationTime > currentTime)
            lease = terminationTime - currentTime;
        this.cam.events.terminationTime = new Date(Date.now() + lease);
        return lease;
    }

    /**
     * Classifies a single ONVIF notification message. This is shared by both event transports:
     * PullPoint delivers messages through the onvif library's 'event' emitter, while
     * WS-BaseNotification push delivers them through the camera's HTTP callback. Both produce
     * the same linerased message shape, so semantics do not diverge between transports.
     */
    handleNotification(ret: EventEmitter, event: any, xml: string) {
        ret.emit('data', xml);

        const message = event?.message?.message;
        const topic = event?.topic?._;
        if (!message || typeof topic !== 'string')
            return;

        const { items: dataItems, values: data } = normalizeSimpleItems(message.data);
        if (!dataItems.length)
            return;

        // retained so the single valued handling below is unchanged for existing cameras.
        const dataValue = dataItems[0].$.Value;
        const eventTopic = stripNamespaces(topic);
        const operation = message.$?.PropertyOperation;

        if (this.debugEvents) {
            // the camera supplied time is recorded alongside the local receive time because
            // some firmware reuses a stale value, and only the local time is trustworthy.
            const record = {
                topic: eventTopic,
                operation,
                source: normalizeSimpleItems(message.source).values,
                data,
                cameraUtcTime: message.$?.UtcTime,
                receivedAt: new Date().toISOString(),
            };
            this.console.log('onvif event:', JSON.stringify(record));
            this.onDebugEvent?.(record);
        }

        ret.emit('onvifEvent', eventTopic, dataValue);

        if (eventTopic.includes('MotionAlarm')) {
            // ret.emit('event', OnvifEvent.MotionBuggy);
            if (dataValue)
                ret.emit('event', OnvifEvent.MotionStart)
            else
                ret.emit('event', OnvifEvent.MotionStop)
        }
        else if (eventTopic.includes('DetectedSound')) {
            if (dataValue)
                ret.emit('event', OnvifEvent.AudioStart)
            else
                ret.emit('event', OnvifEvent.AudioStop)
        }
        // Reolink
        else if (eventTopic.includes('Visitor') && (dataValue === true || dataValue === false)) {
            if (dataValue) {
                ret.emit('event', OnvifEvent.BinaryStart)
            }
            else {
                ret.emit('event', OnvifEvent.BinaryStop)
            }
        }
        // Mobotix T26
        else if (eventTopic.includes('VideoSource/Alarm')) {
            if (dataValue === "Ring" || dataValue === "CameraBellButton") {
                ret.emit('event', OnvifEvent.BinaryRingEvent);
            }
        }
        // else if (eventTopic.includes('DigitalInput')) {
        //     if (dataValue)
        //         ret.emit('event', OnvifEvent.BinaryStart)
        //     else
        //         ret.emit('event', OnvifEvent.BinaryStop)
        // }
        else if (this.binaryStateEvent && eventTopic.includes(this.binaryStateEvent)) {
            if (dataValue)
                ret.emit('event', OnvifEvent.BinaryStart)
            else
                ret.emit('event', OnvifEvent.BinaryStop)
        }
        else if (eventTopic.includes('RuleEngine/CellMotionDetector/Motion')) {
            // unclear if the IsMotion false is indicative of motion stop?
            if (isTrue(data.IsMotion)) {
                ret.emit('event', OnvifEvent.MotionBuggy);
            }
        }
        // TP-Link/Tapo does not report person detection through the standard ObjectDetector
        // rule tree.
        else if (eventTopic.includes('RuleEngine/PeopleDetector/People')) {
            if (operation !== 'Initialized' && isTrue(data.IsPeople))
                ret.emit('event', OnvifEvent.Detection, 'person');
        }
        // Some Tapo firmware emits IsVehicle and IsPet at runtime even though
        // GetEventProperties declares only IsTPSmartEvent. Runtime Notify fields must therefore
        // not be restricted to the advertised schema.
        else if (eventTopic.includes('RuleEngine/TPSmartEventDetector/TPSmartEvent')) {
            for (const [eventName, value] of Object.entries(data)) {
                const className = TPSMART_DETECTION_CLASSES[eventName];
                if (!className) {
                    this.logUnknownProperty(eventTopic, eventName);
                    continue;
                }
                if (operation !== 'Initialized' && isTrue(value))
                    ret.emit('event', OnvifEvent.Detection, className);
            }
        }
        else if (eventTopic.includes('RuleEngine/ObjectDetector')) {
            // an Initialized notification reports the current state of the rule rather than a
            // new detection, and must not surface as a user facing object detection.
            if (operation !== 'Initialized') {
                for (const [eventName, value] of Object.entries(data)) {
                    if (!isTrue(value))
                        continue;
                    const className = this.detections?.get(eventName);
                    if (!className) {
                        this.logUnknownProperty(eventTopic, eventName);
                        continue;
                    }
                    this.console.log('object detected:', className);
                    ret.emit('event', OnvifEvent.Detection, className);
                }
            }
        }
        else {
            for (const eventName of Object.keys(data))
                this.logUnknownProperty(eventTopic, eventName);
        }
    }

    /**
     * Vendor firmware may emit properties that are not described by GetEventProperties, so
     * unrecognized fields are reported rather than silently dropped. Log once per topic and
     * property to avoid spamming the console on every notification.
     */
    logUnknownProperty(eventTopic: string, eventName: string) {
        const key = `${eventTopic}/${eventName}`;
        if (this.loggedUnknownProperties.has(key))
            return;
        this.loggedUnknownProperties.add(key);
        this.console.log('unhandled onvif event property:', key);
    }

    async canConfigureEncoding() {
        const ret: any = await promisify(cb => this.cam.getMediaServiceCapabilities(cb));
        return !!ret.profileCapabilities;
    }

    async getVideoEncoderConfigurationOptions(profileToken: string, configurationToken: string): Promise<VideoStreamConfiguration> {
        const options: any = await promisify(cb => this.cam.getVideoEncoderConfigurationOptions({ profileToken }, cb));
        const codecs: string[] = [];
        if (options.H264)
            codecs.push('h264');
        if (options.H265)
            codecs.push('h265');

        let qualityRange: [number, number];
        const resolutions: [number, number][] = [];
        let fpsRange: [number, number];
        let keyframeIntervalRange: [number, number];
        const profiles: string[] = [];
        let bitrateRange: [number, number];

        const ensureArray = (value: any): any => {
            if (!Array.isArray(value))
                return [value];
            return value;
        };

        const H264 = options?.extension?.H264 || options?.H264;
        if (H264) {
            if (H264?.H264ProfilesSupported)
                profiles.push(...ensureArray(H264.H264ProfilesSupported).map(p => p.toLowerCase()));
            if (H264?.resolutionsAvailable)
                resolutions.push(...ensureArray(H264.resolutionsAvailable).map(r => [r.width, r.height]));
            if (H264?.frameRateRange?.min || H264?.frameRateRange?.max)
                fpsRange = [H264.frameRateRange.min, H264.frameRateRange.max];
            if (H264?.govLengthRange?.min || H264?.govLengthRange?.max)
                keyframeIntervalRange = [H264.govLengthRange.min, H264.govLengthRange.max];
            if (H264?.bitrateRange?.min || H264?.bitrateRange?.max)
                bitrateRange = [H264.bitrateRange.min, H264.bitrateRange.max];
        }
        if (options.qualityRange?.min || options?.qualityRange?.max)
            qualityRange = [options.qualityRange.min, options.qualityRange.max];

        // if (config?.)

        return {
            codecs,
            qualityRange,
            fpsRange,
            keyframeIntervalRange,
            resolutions,
            profiles,
            bitrateRange,
        }
    }

    async setVideoEncoderConfiguration(configuration: any) {
        return promisify(cb => this.cam.setVideoEncoderConfiguration(configuration, cb));
    }

    async setAudioEncoderConfiguration(configuration: any) {
        return promisify(cb => this.cam.setAudioEncoderConfiguration(configuration, cb));
    }

    async getProfiles() {
        if (!this.profiles) {
            this.profiles = promisify(cb => this.cam.getProfiles(cb));
            this.profiles.catch(() => this.profiles = undefined);
        }
        return this.profiles;
    }

    async getMainProfileToken() {
        const profiles = await this.getProfiles();
        const { token } = profiles[0].$;
        return token;
    }

    async supportsEvents(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.cam.getCapabilities((err: Error, data: any, xml: string) => {
                if (err) {
                    this.console.log('supportsEvents error', err);
                    return reject(err);
                }
                if (!err && data.events && data.events.WSPullPointSupport && data.events.WSPullPointSupport === true) {
                    this.console.log('Camera supports WSPullPoint', xml);
                } else {
                    this.console.log('Camera does not show WSPullPoint support, but trying anyway', xml);
                }

                resolve(undefined);
            });
        })
    }

    async createSubscription(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.cam.createPullPointSubscription((err: Error, data: any, xml: string) => {
                if (err) {
                    this.console.log('createSubscription error', err);
                    return reject(err);
                }

                resolve(undefined);
            });
        })
    }

    unsubscribe() {
        return new Promise((resolve, reject) => {
            this.cam.unsubscribe((err: Error, data: any, xml: string) => {
                if (err) {
                    this.console.log('unsubscribe error', err);
                    return reject(err);
                }

                resolve(undefined);
            });
        })
    }

    async getEventTypes(): Promise<string[]> {
        if (this.detections)
            return [...this.detections.values()];

        return new Promise((resolve, reject) => {
            this.cam.getEventProperties((err, data, xml) => {
                if (err) {
                    this.console.log('getEventTypes error', err);
                    return reject(err);
                }

                this.console.log(xml);
                this.detections = new Map();
                try {
                    if (data.topicSet.ruleEngine.objectDetector) {
                        for (const [className, entry] of Object.entries(data.topicSet.ruleEngine.objectDetector) as any) {
                            try {
                                const eventName = entry.messageDescription.data.simpleItemDescription.$.Name;
                                this.detections.set(eventName, className);
                            }
                            catch (e) {
                            }
                        }
                    }
                }
                catch (e) {
                }

                try {
                    // Tapo reports person and vehicle detection outside the standard
                    // ObjectDetector tree.
                    if (data.topicSet.ruleEngine.peopleDetector)
                        this.detections.set('IsPeople', 'person');
                    // The TPSmartEvent rule only declares IsTPSmartEvent, but it is the rule
                    // that carries the smart classes at runtime. Claim them from the rule
                    // rather than from the declared property, otherwise a class cannot be
                    // selected anywhere in Scrypted until one happens to occur.
                    if (data.topicSet.ruleEngine.TPSmartEventDetector) {
                        for (const [property, className] of Object.entries(TPSMART_DETECTION_CLASSES))
                            this.detections.set(property, className);
                    }
                }
                catch (e) {
                }

                resolve([...this.detections.values()]);
            });
        })
    }

    async getStreamUrl(profileToken?: string): Promise<string> {
        if (!profileToken)
            profileToken = await this.getMainProfileToken();
        if (!this.rtspUrls.has(profileToken)) {
            const result = await promisify(cb => this.cam.getStreamUri({ protocol: 'RTSP', profileToken }, cb)) as any;
            const url = result.uri;
            this.rtspUrls.set(profileToken, url);
        }
        return this.rtspUrls.get(profileToken);
    }

    async jpegSnapshot(profileToken?: string, timeout = 10000): Promise<Buffer | undefined> {
        if (!profileToken)
            profileToken = await this.getMainProfileToken();
        if (!this.snapshotUrls.has(profileToken)) {
            try {
                const result = await promisify(cb => this.cam.getSnapshotUri({ profileToken }, cb)) as any;
                const url = result.uri;
                this.snapshotUrls.set(profileToken, url);
            }
            catch (e) {
                if (e.message && e.message.indexOf('ActionNotSupported') !== -1) {
                    this.snapshotUrls.set(profileToken, undefined);
                }
                else {
                    throw e;
                }
            }
        }
        const snapshotUri = this.snapshotUrls.get(profileToken);
        if (!snapshotUri)
            return;

        const response = await this.request({
            url: snapshotUri,
            timeout,
        });

        return response.body;
    }

    getDeviceInformation(): Promise<any> {
        return promisify(cb => {
            this.cam.getDeviceInformation(cb);
        })
    }

    async getOSDs(): Promise<any> {
        // this function accept video token but why?
        return promisify(cb => {
            this.cam.getOSDs(cb);
        });
    }

    async setOSD(osd: any) {
        return promisify(cb => {
            this.cam.setOSD(osd, cb);
        });
    }
}

export async function connectCameraAPI(ipAndPort: string, username: string, password: string, console: Console, binaryStateEvent: string) {
    const split = ipAndPort.split(':');
    const [hostname, port] = split;
    const cam = await promisify(cb => {
        const cam = new Cam({
            hostname,
            username,
            password,
            port,
        }, (err: Error) => cb(err, cam));
    });
    return new OnvifCameraAPI(cam, username, password, console, binaryStateEvent);
}
