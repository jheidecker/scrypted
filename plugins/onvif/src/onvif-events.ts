import { ObjectsDetected, ScryptedDevice, ScryptedDeviceBase, ScryptedInterface } from "@scrypted/sdk";
import { OnvifCameraAPI, OnvifEvent } from "./onvif-api";
import { Destroyable } from "../../rtsp/src/rtsp";

export type OnvifEventTransport = 'auto' | 'pullpoint' | 'push';

/**
 * Supplied by the camera device to enable the WS-BaseNotification push transport. The device
 * owns the Scrypted HTTP endpoint, so it provides the consumer url and routes callback bodies
 * back to the subscription.
 */
export interface OnvifPushOptions {
    transport: OnvifEventTransport;
    getCallbackUrl(): Promise<string>;
    register(handler: (xml: string) => void): void;
    unregister(): void;
}

/**
 * 'motion' is the camera's own motion rule. Any other value is an object detection class, and
 * a detection of that class will also set the motion sensor.
 */
export type OnvifMotionEvent = 'motion' | string;

export interface OnvifListenOptions {
    push?: OnvifPushOptions;
    /**
     * Which events set the camera's motion sensor. Defaults to the camera's own motion rule,
     * which is the behavior of any caller that does not configure this.
     */
    motionEvents?: OnvifMotionEvent[];
}

// renew comfortably before the lease expires, derived from the lease the camera actually
// accepted rather than its wall clock.
const RENEW_LEASE_FRACTION = 0.65;
const MIN_RENEW_MS = 15000;
const MAX_RENEW_MS = 600000;
// bounded backoff used while there is still lease time remaining.
const RENEW_RETRY_MS = 10000;
const MAX_SUBSCRIBE_FAILURES = 3;

function computeRenewDelay(leaseMs: number) {
    return Math.min(Math.max(leaseMs * RENEW_LEASE_FRACTION, MIN_RENEW_MS), MAX_RENEW_MS);
}

export async function listenEvents(thisDevice: ScryptedDeviceBase, client: OnvifCameraAPI, motionTimeoutMs = 30000, options?: OnvifListenOptions) {
    const push = options?.push;
    // an empty or absent selection keeps the historical behavior: only the camera's own motion
    // rule drives the motion sensor.
    const motionEvents = options?.motionEvents?.length ? options.motionEvents : ['motion'];
    const motionOnMotion = motionEvents.includes('motion');
    let motionTimeout: NodeJS.Timeout;
    let binaryTimeout: NodeJS.Timeout;
    let renewTimeout: NodeJS.Timeout;
    let destroyed = false;

    const triggerMotion = () => {
        thisDevice.motionDetected = true;
        clearTimeout(motionTimeout);
        motionTimeout = setTimeout(() => thisDevice.motionDetected = false, motionTimeoutMs);
    };

    const transport = push?.transport || 'pullpoint';
    let usePush = transport === 'push';

    if (!usePush) {
        try {
            await client.supportsEvents();
        }
        catch (e) {
        }

        try {
            await client.createSubscription();
        }
        catch (e) {
            // silence is not evidence that PullPoint is broken, so only a concrete setup
            // failure is allowed to select the push transport.
            if (transport !== 'auto' || !push)
                throw e;
            thisDevice.console.warn('onvif pullpoint subscription failed, falling back to push transport', e);
            usePush = true;
        }
    }

    const events = usePush ? client.listenPushEvents() : client.listenEvents();

    if (usePush) {
        const callbackUrl = await push.getCallbackUrl();
        thisDevice.console.log('onvif event transport: push');
        thisDevice.console.log('onvif push callback:', callbackUrl);

        push.register(xml => {
            if (destroyed)
                return;
            client.handlePushXml(events, xml);
        });

        const scheduleRenew = (delay: number) => {
            clearTimeout(renewTimeout);
            if (destroyed)
                return;
            renewTimeout = setTimeout(maintain, delay);
        };

        // the lease expiry as computed from the last accepted subscription, used to decide
        // whether a failed maintenance attempt still has time left to retry.
        let leaseExpires = 0;
        let failures = 0;

        const accepted = (lease: number, what: string) => {
            leaseExpires = Date.now() + lease;
            failures = 0;
            const delay = computeRenewDelay(lease);
            thisDevice.console.log(`onvif push subscription ${what}; lease=${Math.round(lease / 1000)}s; renew in=${Math.round(delay / 1000)}s`);
            // the rtsp listen loop destroys a listener that has been idle for five minutes.
            // a push camera may legitimately have nothing to report for far longer than that,
            // so keeping the subscription alive counts as listener activity.
            events.emit('data', `onvif push subscription ${what}`);
            scheduleRenew(delay);
        };

        const maintain = async () => {
            if (destroyed)
                return;

            try {
                accepted(await client.pushRenew(), 'renewed');
                return;
            }
            catch (e) {
                if (destroyed)
                    return;
                thisDevice.console.warn('onvif push renew rejected, replacing subscription:', e.message || e);
            }

            // The camera refused to extend the lease. A camera that has restarted, or has
            // otherwise forgotten the subscription, faults every Renew while still honouring a
            // fresh Subscribe, so retrying the renewal only burns the rest of the lease.
            // Replace the subscription instead. The consumer url is unchanged, so the camera
            // keeps posting to the same callback.
            try {
                await client.unsubscribe().catch(() => { });
                if (destroyed)
                    return;
                accepted(await client.pushSubscribe(callbackUrl), 'replaced');
            }
            catch (e) {
                if (destroyed)
                    return;
                failures++;
                const remaining = leaseExpires - Date.now();
                if (failures < MAX_SUBSCRIBE_FAILURES && remaining > RENEW_RETRY_MS) {
                    thisDevice.console.warn(`onvif push resubscribe failed, retrying; lease expires in ${Math.round(remaining / 1000)}s`, e.message || e);
                    scheduleRenew(RENEW_RETRY_MS);
                    return;
                }
                // out of options. tear down rather than stacking subscriptions, and let the
                // listen loop rebuild from scratch.
                thisDevice.console.error('onvif push subscription lost, reconnecting', e.message || e);
                events.emit('error', e);
            }
        };

        try {
            accepted(await client.pushSubscribe(callbackUrl), 'active');
        }
        catch (e) {
            // the Destroyable is never returned when subscribe fails, so clean up the callback
            // registration here rather than leaking it until the next listener teardown.
            destroyed = true;
            clearTimeout(renewTimeout);
            push.unregister();
            throw e;
        }
    }
    else {
        thisDevice.console.log('onvif event transport: pullpoint');
    }

    thisDevice.console.log('listening events');
    events.on('event', (event, className) => {
        if (event === OnvifEvent.MotionBuggy) {
            // some onvif cameras have motion with no associated motion end event.
            if (motionOnMotion)
                triggerMotion();
            return;
        }
        if (event === OnvifEvent.BinaryRingEvent) {
            thisDevice.binaryState = true;
            clearTimeout(binaryTimeout);
            binaryTimeout = setTimeout(() => thisDevice.binaryState = false, motionTimeoutMs);
            return;
        }

        if (event === OnvifEvent.MotionStart) {
            // some onvif cameras (like the reolink doorbell) have very short duration motion
            // events.
            // furthermore, cameras are not guaranteed to send motion stop events, which makes.
            // for the sake of providing normalized motion durations through scrypted, debounce the motion.
            if (motionOnMotion)
                triggerMotion();
            // thisDevice.motionDetected = true;
        }
        else if (event === OnvifEvent.MotionStop) {
            // reset the trigger to debounce per above.
            if (motionOnMotion && thisDevice.motionDetected)
                triggerMotion();

            // thisDevice.motionDetected = false;
        }
        else if (event === OnvifEvent.AudioStart)
            thisDevice.audioDetected = true;
        else if (event === OnvifEvent.AudioStop)
            thisDevice.audioDetected = false;
        else if (event === OnvifEvent.BinaryStart)
            thisDevice.binaryState = true;
        else if (event === OnvifEvent.BinaryStop)
            thisDevice.binaryState = false;
        else if (event === OnvifEvent.Detection) {
            // a camera whose motion rule is noisy, or which never sends one, can drive the
            // motion sensor from a detection class instead.
            if (className && motionEvents.includes(className))
                triggerMotion();
            const d: ObjectsDetected = {
                // the camera supplied UtcTime is unreliable on some firmware, so scrypted
                // events are always stamped with the local receive time.
                timestamp: Date.now(),
                detections: [
                    {
                        score: undefined,
                        className,
                    }
                ]
            }
            thisDevice.onDeviceEvent(ScryptedInterface.ObjectDetector, d);
        }
    });

    const ret = {
        destroy() {
            if (destroyed)
                return;
            destroyed = true;
            clearTimeout(binaryTimeout);
            clearTimeout(motionTimeout);
            clearTimeout(renewTimeout);
            push?.unregister();
            client.unsubscribe()
                .catch(e => thisDevice.console.warn('Error unsubscribing', e));
        },
        on(eventName: string | symbol, listener: (...args: any[]) => void) {
            return events.on(eventName, listener);
        },
        emit(eventName: string | symbol, ...args: any[]) {
            return events.emit(eventName, ...args);
        },
        triggerMotion,
    };

    return ret;
}
