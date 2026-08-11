import sdk, { AdoptDevice, Device, DeviceCreatorSettings, DeviceDiscovery, DeviceInformation, DiscoveredDevice, HttpRequest, HttpRequestHandler, HttpResponse, Intercom, MediaObject, MediaStreamOptions, ObjectDetectionTypes, ObjectDetector, PictureOptions, Reboot, RequestPictureOptions, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, Setting, SettingValue, VideoCamera, VideoCameraConfiguration, VideoTextOverlay, VideoTextOverlays } from "@scrypted/sdk";
import crypto from 'crypto';
import { AddressInfo } from "net";
import onvif from 'onvif';
import { Stream } from "stream";
import xml2js from 'xml2js';
import { RtspProvider, RtspSmartCamera, UrlMediaStreamOptions } from "../../rtsp/src/rtsp";
import { connectCameraAPI, OnvifCameraAPI, OnvifEvent } from "./onvif-api";
import { autoconfigureSettings, configureCodecs, getCodecs } from "./onvif-configure";
import { listenEvents, OnvifEventTransport, OnvifListenOptions, OnvifPushOptions } from "./onvif-events";
import { OnvifIntercom } from "./onvif-intercom";
import { OnvifPTZMixinProvider } from "./onvif-ptz";
import { automaticallyConfigureSettings, checkPluginNeedsAutoConfigure, onvifAutoConfigureSettings } from "@scrypted/common/src/autoconfigure-codecs";

const { endpointManager, mediaManager, systemManager, deviceManager } = sdk;

const TRANSPORT_CHOICES: { [choice: string]: OnvifEventTransport } = {
    'Auto': 'auto',
    'PullPoint': 'pullpoint',
    'Push (WS-BaseNotification)': 'push',
};

function toChoice(event: string) {
    return event.charAt(0).toUpperCase() + event.slice(1);
}

function safeEquals(a: string, b: string) {
    if (typeof a !== 'string' || typeof b !== 'string')
        return false;
    if (a.length !== b.length)
        return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++)
        mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return mismatch === 0;
}

class OnvifCamera extends RtspSmartCamera implements ObjectDetector, Intercom, VideoCameraConfiguration, Reboot, VideoTextOverlays, HttpRequestHandler {
    eventStream: Stream;
    client: OnvifCameraAPI;
    rtspMediaStreamOptions: Promise<UrlMediaStreamOptions[]>;
    intercom = new OnvifIntercom(this);
    /**
     * Identifies the current push subscription's callback. This is deliberately not persisted:
     * a plugin reload invalidates it, so a late POST from a camera holding a stale subscription
     * is rejected rather than resurrecting torn down state.
     */
    pushToken: string;
    pushHandler: (xml: string) => void;
    loggedPushContentType = false;

    constructor(nativeId: string, provider: RtspProvider) {
        super(nativeId, provider);

        this.updateDeviceInfo();
        this.updateDevice();
    }

    async reboot(): Promise<void> {
        const client = await this.getClient();
        await client.reboot();
    }

    async setVideoStreamOptions(options: MediaStreamOptions) {
        this.rtspMediaStreamOptions = undefined;
        const client = await this.getClient();
        const ret = await configureCodecs(this.console, client, options);
        return ret;
    }

    async updateDeviceInfo() {
        const ip = this.storage.getItem('ip');
        if (!ip)
            return;
        const client = await this.getClient();
        const onvifInfo = await client.getDeviceInformation().catch(() => { });

        const managementUrl = `http://${ip}`;
        let info = {
            ...this.info,
            managementUrl,
            ip,
        };
        if (onvifInfo) {
            info = {
                ...info,
                serialNumber: onvifInfo.serialNumber,
                manufacturer: onvifInfo.manufacturer,
                firmware: onvifInfo.firmwareVersion,
                model: onvifInfo.model,
            }
        }

        this.info = info;
    }

    async getVideoTextOverlays(): Promise<Record<string, VideoTextOverlay>> {
        const client = await this.getClient();
        const osds = await client.getOSDs();
        const ret: Record<string, VideoTextOverlay> = {};
        for (const osd of osds.getOSDsResponse.OSDs) {
            const id = osd.$.token;
            const readonly = osd.textString.type !== 'Plain' ? true : undefined;
            // readonly toggling not supported
            if (readonly)
                continue;
            ret[id] = {
                text: !readonly ? osd.textString.plainText : osd.textString.type,
                readonly,
            }
        }
        return ret;
    }

    async setVideoTextOverlay(id: string, value: VideoTextOverlay): Promise<void> {
        const client = await this.getClient();
        const osds = await client.getOSDs();
        const osd = osds.getOSDsResponse.OSDs.find(osd => osd.$.token === id);
        if (!osd)
            throw new Error('osd not found');
        osd.textString.plainText = value.text;
        await client.setOSD({
            OSDToken: osd.$.token,
            plaintext: value.text,
            position: osd.position.type === 'Custom'
                ? {
                    ...osd.position.pos.$,
                }
                : osd.position,
        });
    }

    getDetectionInput(detectionId: any, eventId?: any): Promise<MediaObject> {
        throw new Error("Method not implemented.");
    }

    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        const client = await this.getClient();
        const classes = await client.getEventTypes();
        // include classes that were only ever observed at runtime.
        for (const className of this.getStoredDetectionClasses()) {
            if (!classes.includes(className))
                classes.push(className);
        }
        return {
            classes,
        }
    }

    async getPictureOptions(): Promise<PictureOptions[]> {
        try {
            const vsos = await this.getVideoStreamOptions();
            const ret = vsos.map(({ id, name, video }) => ({
                id,
                name,
                // onvif doesn't actually specify the snapshot dimensions for a profile.
                // it may just send whatever.
                picture: {
                    width: video?.width,
                    height: video?.height,
                }
            }));
            return ret;
        }
        catch (e) {
        }
    }

    async takeSmartCameraPicture(options?: RequestPictureOptions): Promise<MediaObject> {
        const client = await this.getClient();
        let snapshot: Buffer;
        let id = options?.id;

        if (!id) {
            const vsos = await this.getVideoStreamOptions();
            const vso = this.getDefaultStream(vsos);
            id = vso?.id;
        }

        snapshot = await client.jpegSnapshot(id, options?.timeout);

        // it is possible that onvif does not support snapshots, in which case return the video stream
        if (!snapshot) {
            // grab the real device rather than the using this.getVideoStream
            // so we can take advantage of the rebroadcast plugin if available.
            const realDevice = systemManager.getDeviceById<VideoCamera>(this.id);
            return realDevice.getVideoStream({
                id,
            });

            // todo: this is bad. just disable camera interface altogether.
        }
        return mediaManager.createMediaObject(snapshot, 'image/jpeg');
    }

    async getConstructedVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        if (this.rtspMediaStreamOptions)
            return this.rtspMediaStreamOptions;

        this.rtspMediaStreamOptions = new Promise(async (resolve) => {
            try {
                const client = await this.getClient();
                const ret = await getCodecs(this.console, client);

                if (!ret.length)
                    throw new Error('onvif camera had no profiles.');

                resolve(ret);
            }
            catch (e) {
                this.rtspMediaStreamOptions = undefined;
                this.console.error('error retrieving onvif profiles', e);
                resolve(undefined);
            }
        });

        return this.rtspMediaStreamOptions;
    }


    getEventTransport(): OnvifEventTransport {
        const transport = this.storage.getItem('onvifEventTransport') as OnvifEventTransport;
        if (transport === 'pullpoint' || transport === 'push')
            return transport;
        return 'auto';
    }

    /**
     * Whether this camera should expose the push callback endpoint. Auto only needs it once it
     * has actually fallen back to push, so cameras happily using PullPoint do not report an
     * endpoint they will never receive anything on.
     */
    pushEndpointEnabled() {
        return this.getEventTransport() === 'push'
            || this.storage.getItem('onvifPushFallback') === 'true';
    }

    async getPushCallbackUrl() {
        // the endpoint must be public because the camera cannot authenticate with scrypted, and
        // insecure because cameras generally will not trust scrypted's self signed certificate.
        const endpoint = await endpointManager.getLocalEndpoint(this.nativeId, {
            public: true,
            insecure: true,
        });
        return `${endpoint}push/${this.pushToken}`;
    }

    createPushOptions(): OnvifPushOptions {
        return {
            transport: this.getEventTransport(),
            getCallbackUrl: async () => {
                // the server only routes the camera's post to this device if it reports the
                // interface, so make sure that has happened before handing out the url.
                if (!this.pushEndpointEnabled()) {
                    this.storage.setItem('onvifPushFallback', 'true');
                    await this.updateDevice();
                }
                this.pushToken = crypto.randomBytes(16).toString('hex');
                return this.getPushCallbackUrl();
            },
            register: handler => this.pushHandler = handler,
            unregister: () => {
                this.pushHandler = undefined;
                this.pushToken = undefined;
            },
        };
    }

    /**
     * Receives WS-BaseNotification Notify messages posted by the camera.
     */
    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        // respond immediately. the camera must not be made to wait on downstream scrypted work,
        // and the request body has already been read by the server.
        const path = request.url.substring(request.rootPath.length).split('?')[0];
        const [, route, token] = path.split('/');

        if (route !== 'push') {
            response.send('Not Found', { code: 404 });
            return;
        }
        if (request.method !== 'POST') {
            response.send('Method Not Allowed', { code: 405 });
            return;
        }
        if (!this.pushHandler || !this.pushToken || !safeEquals(token, this.pushToken)) {
            // an expired or unknown subscription. the camera should stop posting once its
            // lease lapses.
            response.send('Gone', { code: 410 });
            return;
        }

        response.send('ok', { code: 200 });

        try {
            const xml = this.decodePushBody(request);
            if (xml)
                this.pushHandler(xml);
        }
        catch (e) {
            this.console.warn('error handling onvif push callback', e);
        }
    }

    /**
     * The scrypted server parses endpoint request bodies before the plugin sees them. An ONVIF
     * Notify is posted as application/soap+xml, which the server's raw body parser turns into a
     * Buffer and then serializes as JSON, so unwrap that here.
     */
    decodePushBody(request: HttpRequest) {
        const body = request.body;
        if (!body)
            return;
        if (body.trimStart().startsWith('<'))
            return body;
        try {
            const parsed = JSON.parse(body);
            if (parsed?.type === 'Buffer' && Array.isArray(parsed.data))
                return Buffer.from(parsed.data).toString('utf8');
        }
        catch (e) {
        }
        if (!this.loggedPushContentType) {
            this.loggedPushContentType = true;
            this.console.warn('onvif push callback body could not be decoded. content-type:', request.headers?.['content-type']);
        }
    }

    /**
     * Records an object detection class observed at runtime. Some firmware reports classes that
     * GetEventProperties never advertised, so the runtime notification is authoritative.
     */
    addDetectionClass(className: string) {
        const classes = this.getStoredDetectionClasses();
        if (classes.includes(className))
            return;
        classes.push(className);
        this.storage.setItem('onvifDetectionClasses', JSON.stringify(classes));
        this.storage.setItem('onvifDetector', 'true');
        this.console.log('discovered onvif detection class:', className);
        this.updateDevice();
    }

    getStoredDetectionClasses(): string[] {
        try {
            const classes = JSON.parse(this.storage.getItem('onvifDetectionClasses'));
            if (Array.isArray(classes))
                return classes;
        }
        catch (e) {
        }
        return [];
    }

    /**
     * The events that set this camera's motion sensor. Defaults to the camera's own motion
     * rule, which is the historical behavior.
     */
    getMotionEvents(): string[] {
        const stored = this.storage.getItem('onvifMotionEvents');
        if (stored) {
            try {
                const events = JSON.parse(stored);
                // an empty selection is a deliberate choice, not an unset value, and must not
                // fall back to the default.
                if (Array.isArray(events))
                    return events.map(event => `${event}`);
            }
            catch (e) {
            }
        }
        return ['motion'];
    }

    async listenEvents() {
        const client = await this.createClient();
        try {
            const eventTypes = await client.getEventTypes();
            if (eventTypes?.length && this.storage.getItem('onvifDetector') !== 'true') {
                this.storage.setItem('onvifDetector', 'true');
                this.updateDevice();
            }
            // persist the advertised classes so they can be selected in settings without
            // waiting for the camera to report one, and without a live connection.
            for (const className of eventTypes || [])
                this.addDetectionClass(className);
        }
        catch (e) {
        }

        const transport = this.getEventTransport();
        const options: OnvifListenOptions = {
            push: transport === 'pullpoint' ? undefined : this.createPushOptions(),
            motionEvents: this.getMotionEvents(),
        };
        const ret = await listenEvents(this, client, 30000, options);

        ret.on('event', (event: OnvifEvent, className: string) => {
            if (event === OnvifEvent.Detection && className)
                this.addDetectionClass(className);
        });

        return ret;
    }

    createClient() {
        return connectCameraAPI(this.getHttpAddress(), this.getUsername(), this.getPassword(), this.console, this.storage.getItem('onvifDoorbellEvent'));
    }

    async getClient() {
        if (!this.client)
            this.client = await this.createClient();
        return this.client;
    }

    showRtspUrlOverride() {
        return false;
    }

    showRtspPortOverride() {
        return false;
    }

    showHttpPortOverride() {
        return true;
    }

    showSnapshotUrlOverride() {
        return false;
    }

    async getOtherSettings(): Promise<Setting[]> {
        const isDoorbell = !!this.providedInterfaces?.includes(ScryptedInterface.BinarySensor);

        const ret: Setting[] = [
            ...await super.getOtherSettings(),
            {
                subgroup: 'Advanced',
                title: 'Onvif Doorbell',
                type: 'boolean',
                description: 'Enable if this device is a doorbell',
                key: 'onvifDoorbell',
                value: isDoorbell.toString(),
            },
            {
                subgroup: 'Advanced',
                title: 'Onvif Doorbell Event Name',
                type: 'string',
                description: 'Onvif event name to trigger the doorbell',
                key: "onvifDoorbellEvent",
                value: this.storage.getItem('onvifDoorbellEvent'),
                placeholder: 'EventName'
            },
        ];

        if (!isDoorbell) {
            ret.push(
                {
                    subgroup: 'Advanced',
                    title: 'Two Way Audio',
                    description: 'Enable if this device supports two way audio over ONVIF.',
                    type: 'boolean',
                    key: 'onvifTwoWay',
                    value: (!!this.providedInterfaces?.includes(ScryptedInterface.Intercom)).toString(),
                }
            )
        }

        const transport = this.getEventTransport();
        ret.push({
            subgroup: 'Advanced',
            title: 'ONVIF Event Transport',
            description: 'The mechanism used to receive events from the camera. Auto uses PullPoint and only falls back to Push if the PullPoint subscription cannot be created. Some cameras, such as current Tapo firmware, accept a PullPoint subscription but never deliver events, and require Push.',
            type: 'string',
            key: 'onvifEventTransport',
            choices: Object.keys(TRANSPORT_CHOICES),
            value: Object.keys(TRANSPORT_CHOICES).find(choice => TRANSPORT_CHOICES[choice] === transport),
        });

        const motionEvents = this.getMotionEvents();
        // the camera accessory in HomeKit, and other consumers that only understand a motion
        // sensor, can be pointed at a detection class instead of the camera's motion rule.
        // persisted rather than queried, so an unreachable camera cannot stall the settings page.
        const motionChoices = ['motion', ...this.getStoredDetectionClasses()];
        ret.push({
            subgroup: 'Advanced',
            title: 'Motion Sensor Events',
            description: 'Which camera events set the motion sensor. Defaults to the motion rule. Selecting a detection class instead is useful for consumers that only understand a motion sensor, such as the HomeKit camera accessory. Selecting nothing leaves the motion sensor unused, which is reasonable if only object detection events are wanted.',
            type: 'string',
            key: 'onvifMotionEvents',
            multiple: true,
            choices: motionChoices.map(toChoice),
            value: motionEvents.map(toChoice),
        });

        if (this.pushToken) {
            ret.push({
                subgroup: 'Advanced',
                title: 'ONVIF Push Callback',
                description: 'The address the camera posts events to. It must be reachable from the camera network.',
                type: 'string',
                key: 'onvifPushCallbackUrl',
                readonly: true,
                value: await this.getPushCallbackUrl(),
            });
        }

        const ac = {
            ...automaticallyConfigureSettings,
            subgroup: 'Advanced',
        };
        ac.type = 'button';
        ret.push(ac);
        ret.push({
            ...onvifAutoConfigureSettings,
            subgroup: 'Advanced',
        });

        return ret;
    }

    updateDevice() {
        const interfaces: string[] = [...this.provider.getInterfaces()];
        if (this.storage.getItem('onvifDetector') === 'true')
            interfaces.push(ScryptedInterface.ObjectDetector);
        if (this.pushEndpointEnabled())
            interfaces.push(ScryptedInterface.HttpRequestHandler);
        const doorbell = this.storage.getItem('onvifDoorbell') === 'true';
        let type: ScryptedDeviceType;
        if (doorbell) {
            interfaces.push(ScryptedInterface.BinarySensor);
            type = ScryptedDeviceType.Doorbell;
        }

        const twoWay = this.storage.getItem('onvifTwoWay') === 'true';
        if (twoWay || doorbell)
            interfaces.push(ScryptedInterface.Intercom);

        const updated = this.provider.updateDevice(this.nativeId, this.name, interfaces, type);
        this.onDeviceEvent(ScryptedInterface.Settings, undefined);
        return updated;
    }

    async putSetting(key: string, value: any) {
        if (key === automaticallyConfigureSettings.key) {
            autoconfigureSettings(this.console, await this.getClient())
                .then(() => {
                    this.log.a('Successfully configured settings.');
                })
                .catch(e => {
                    this.log.a('There was an error automatically configuring settings. More information can be viewed in the console.');
                    this.console.error('error autoconfiguring', e);
                });
            return;
        }

        this.client = undefined;
        this.rtspMediaStreamOptions = undefined;

        this.updateDeviceInfo();

        if (key === 'onvifMotionEvents') {
            const selected = (Array.isArray(value) ? value : [value])
                .map(choice => `${choice}`.toLowerCase())
                .filter(choice => !!choice);
            this.storage.setItem(key, JSON.stringify(selected));
            this.listener?.then(l => l.emit('error', new Error("new settings")));
            return;
        }

        if (key === 'onvifEventTransport') {
            // the setting presents display names, so normalize to the stored value rather than
            // letting the base class persist the label.
            this.storage.setItem(key, TRANSPORT_CHOICES[value as string] || 'auto');
            // an explicit choice supersedes any earlier automatic fallback.
            this.storage.removeItem('onvifPushFallback');
            // report the endpoint interface before the listener restarts and generates the
            // callback url, otherwise the server will not route the camera's post.
            this.updateDevice();
            // restart the event listener, as RtspSmartCamera.putSetting would have.
            this.listener?.then(l => l.emit('error', new Error("new settings")));
            return;
        }

        if (key !== 'onvifDoorbell' && key !== 'onvifTwoWay')
            return super.putSetting(key, value);

        this.storage.setItem(key, value);
        this.updateDevice();
    }

    async startIntercom(media: MediaObject) {
        const options = await this.getConstructedVideoStreamOptions();
        const stream = options[0];
        this.intercom.url = stream.url;
        return this.intercom.startIntercom(media);
    }

    async stopIntercom() {
        return this.intercom.stopIntercom();
    }
}

class OnvifProvider extends RtspProvider implements DeviceDiscovery {
    discoveredDevices = new Map<string, {
        device: Device;
        host: string;
        port: string;
        timeout: NodeJS.Timeout;
    }>();


    constructor(nativeId?: ScryptedNativeId) {
        super(nativeId);
        checkPluginNeedsAutoConfigure(this, 1);

        process.nextTick(() => {
            deviceManager.onDeviceDiscovered({
                name: 'ONVIF PTZ',
                type: ScryptedDeviceType.Internal,
                nativeId: 'ptz',
                interfaces: [
                    ScryptedInterface.MixinProvider,
                ]
            })
        })

        onvif.Discovery.on('device', (cam: any, rinfo: AddressInfo, xml: any) => {
            // Function will be called as soon as the NVT responses

            // Parsing of Discovery responses taken from my ONVIF-Audit project, part of the 2018 ONVIF Open Source Challenge
            // Filter out xml name spaces
            xml = xml.replace(/xmlns([^=]*?)=(".*?")/g, '');

            let parser = new xml2js.Parser({
                attrkey: 'attr',
                charkey: 'payload',                // this ensures the payload is called .payload regardless of whether the XML Tags have Attributes or not
                explicitCharkey: true,
                tagNameProcessors: [xml2js.processors.stripPrefix]   // strip namespace eg tt:Data -> Data
            });
            parser.parseString(xml,
                async (err: Error, result: any) => {
                    if (err) {
                        this.console.error('discovery error', err);
                        return;
                    }
                    const urn = result['Envelope']['Body'][0]['ProbeMatches'][0]['ProbeMatch'][0]['EndpointReference'][0]['Address'][0].payload;
                    const xaddrs = result['Envelope']['Body'][0]['ProbeMatches'][0]['ProbeMatch'][0]['XAddrs'][0].payload;
                    const knownScopes = {
                        'onvif://www.onvif.org/name/': '',
                        'onvif://www.onvif.org/MAC/': '',
                        'onvif://www.onvif.org/hardware/': '',
                    };

                    this.console.log('discovered device payload', xml);
                    try {
                        let scopes = result['Envelope']['Body'][0]['ProbeMatches'][0]['ProbeMatch'][0]['Scopes'][0].payload;
                        const splitScopes = scopes.split(" ") as string[];

                        for (const scope of splitScopes) {
                            for (const known of Object.keys(knownScopes)) {
                                if (scope.startsWith(known)) {
                                    knownScopes[known] = decodeURIComponent(scope.substring(known.length));
                                }
                            }
                        }
                    }
                    catch (e) {
                    }

                    const name = knownScopes["onvif://www.onvif.org/name/"] || 'ONVIF Camera';
                    this.console.log('Discovery Reply from ' + rinfo.address + ' (' + name + ') (' + xaddrs + ') (' + urn + ')');

                    if (deviceManager.getNativeIds().includes(urn) || this.discoveredDevices.has(urn))
                        return;

                    const device: Device = {
                        name,
                        info: {
                            ip: rinfo.address,
                            mac: knownScopes["onvif://www.onvif.org/MAC/"] || undefined,
                            model: knownScopes['onvif://www.onvif.org/hardware/'] || undefined,
                        },
                        nativeId: urn,
                        type: ScryptedDeviceType.Camera,
                        interfaces: this.getInterfaces(),
                    };
                    const onvifUrl = new URL(xaddrs);
                    clearTimeout(this.discoveredDevices.get(urn)?.timeout);
                    this.discoveredDevices.set(urn, {
                        device,
                        host: rinfo.address,
                        port: onvifUrl.port,
                        timeout: setTimeout(() => {
                            this.discoveredDevices.delete(urn);
                        }, 5 * 60 * 1000),
                    });

                    this.onDeviceEvent(ScryptedInterface.DeviceDiscovery, await this.discoverDevices());

                    // const device = await this.getDevice(urn) as OnvifCamera;
                    // device.setIPAddress(rinfo.address);
                    // device.setHttpPortOverride(onvifUrl.port);
                    // this.log.a('Discovered ONVIF Camera. Complete setup by providing login credentials.');
                }
            );
        })
    }

    getScryptedDeviceCreator(): string {
        return 'ONVIF Camera';
    }

    async getDevice(nativeId: string) {
        if (nativeId === 'ptz')
            return new OnvifPTZMixinProvider('ptz');
        return super.getDevice(nativeId);
    }

    getAdditionalInterfaces() {
        return [
            ScryptedInterface.Reboot,
            ScryptedInterface.Camera,
            ScryptedInterface.AudioSensor,
            ScryptedInterface.MotionSensor,
            ScryptedInterface.VideoCameraConfiguration,
            ScryptedInterface.VideoTextOverlays,
        ];
    }

    createCamera(nativeId: string): OnvifCamera {
        return new OnvifCamera(nativeId, this);
    }

    async createDevice(settings: DeviceCreatorSettings, nativeId?: ScryptedNativeId): Promise<string> {
        const httpAddress = `${settings.ip}:${settings.httpPort || 80}`;
        let info: DeviceInformation;;

        const username = settings.username?.toString();
        const password = settings.password?.toString();

        if (settings.autoconfigure) {
            const client = await connectCameraAPI(httpAddress, username, password, this.console, undefined);
            await autoconfigureSettings(this.console, client);
        }

        const skipValidate = settings.skipValidate?.toString() === 'true';
        let ptzCapabilities: string[];
        if (!skipValidate) {
            try {
                const api = await connectCameraAPI(httpAddress, username, password, this.console, undefined);
                const onvifInfo = await api.getDeviceInformation();

                info = {
                    serialNumber: onvifInfo.serialNumber,
                    manufacturer: onvifInfo.manufacturer,
                    firmware: onvifInfo.firmwareVersion,
                    model: onvifInfo.model,
                    managementUrl: `http://${httpAddress}`,
                }

                settings.newCamera = info.model;

                if (api.cam?.services?.find((s: any) => s.namespace === 'http://www.onvif.org/ver20/ptz/wsdl')) {
                    ptzCapabilities = [
                        'Pan',
                        'Tilt',
                    ];
                }
            }
            catch (e) {
                this.console.error('Error adding ONVIF camera', e);
                throw e;
            }
        }
        settings.newCamera ||= 'ONVIF Camera';

        nativeId = await super.createDevice(settings, nativeId);

        const device = await this.getDevice(nativeId) as OnvifCamera;
        device.info = info;
        device.putSetting('username', username);
        device.putSetting('password', password);
        device.setIPAddress(settings.ip?.toString());
        device.setHttpPortOverride(settings.httpPort?.toString());
        device.updateDeviceInfo();

        const intercom = new OnvifIntercom(device);
        try {
            intercom.url = (await device.getConstructedVideoStreamOptions())[0].url;
            if (await intercom.checkIntercom()) {
                device.putSetting('onvifTwoWay', 'true');
            }
        }
        catch (e) {
            this.console.warn("error while probing intercom", e);
        }
        finally {
            intercom.intercomClient?.client.destroy();
        }

        if (ptzCapabilities) {
            try {
                const rd = sdk.systemManager.getDeviceById(device.id);
                const ptz = await this.getDevice('ptz');
                rd.setMixins([...(rd.mixins || []), ptz.id]);
            }
            catch (e) {
            }
        }

        return nativeId;
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        return [
            {
                key: 'username',
                title: 'Username',
            },
            {
                key: 'password',
                title: 'Password',
                type: 'password',
            },
            {
                key: 'ip',
                title: 'IP Address',
                placeholder: '192.168.2.222',
            },
            {
                subgroup: 'Advanced',
                key: 'httpPort',
                title: 'HTTP Port',
                description: 'Optional: Override the HTTP Port from the default value of 80.',
                placeholder: '80',
            },
            { ...automaticallyConfigureSettings },
            { ...onvifAutoConfigureSettings },
            {
                subgroup: 'Advanced',
                key: 'skipValidate',
                title: 'Skip Validation',
                description: 'Add the device without verifying the credentials and network settings.',
                type: 'boolean',
            }
        ]
    }

    async discoverDevices(scan?: boolean): Promise<DiscoveredDevice[]> {
        if (scan)
            onvif.Discovery.probe();
        return [...this.discoveredDevices.values()].map(d => ({
            ...d.device,
            description: d.host,
            settings: [
                {
                    key: 'username',
                    title: 'Username',
                },
                {
                    key: 'password',
                    title: 'Password',
                    type: 'password',
                },
                automaticallyConfigureSettings,
                onvifAutoConfigureSettings,
            ]
        }));
    }

    async adoptDevice(adopt: AdoptDevice): Promise<string> {
        const entry = this.discoveredDevices.get(adopt.nativeId);
        this.onDeviceEvent(ScryptedInterface.DeviceDiscovery, await this.discoverDevices());
        if (!entry)
            throw new Error('device not found');
        adopt.settings.ip = entry.host;
        adopt.settings.httpPort = entry.port;
        if (adopt.settings.autoconfigure) {
            const client = await connectCameraAPI(`${entry.host}:${entry.port || 80}`, adopt.settings.username as string, adopt.settings.password as string, this.console, undefined);
            await autoconfigureSettings(this.console, client);
            adopt.settings.autoconfigure = false;
        }
        await this.createDevice(adopt.settings, adopt.nativeId);
        this.discoveredDevices.delete(adopt.nativeId);
        const device = await this.getDevice(adopt.nativeId) as OnvifCamera;
        return device.id;
    }
}

export default OnvifProvider;
