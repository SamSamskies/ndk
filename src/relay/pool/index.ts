import debug from "debug";
import EventEmitter from "eventemitter3";
import NDK from "../../index.js";
import { NDKRelay, NDKRelayStatus } from "../index.js";

export type NDKPoolStats = {
    total: number;
    connected: number;
    disconnected: number;
    connecting: number;
};

/**
 * Handles connections to all relays. A single pool should be used per NDK instance.
 *
 * @emit connect - Emitted when all relays in the pool are connected, or when the specified timeout has elapsed, and some relays are connected.
 * @emit notice - Emitted when a relay in the pool sends a notice.
 * @emit flapping - Emitted when a relay in the pool is flapping.
 * @emit relay:connect - Emitted when a relay in the pool connects.
 * @emit relay:disconnect - Emitted when a relay in the pool disconnects.
 */
export class NDKPool extends EventEmitter {
    public relays = new Map<string, NDKRelay>();
    private debug: debug.Debugger;
    private temporaryRelayTimers = new Map<string, NodeJS.Timeout>();

    public constructor(relayUrls: string[] = [], ndk: NDK) {
        super();
        this.debug = ndk.debug.extend("pool");
        for (const relayUrl of relayUrls) {
            const relay = new NDKRelay(relayUrl);
            this.addRelay(relay, false);
        }
    }

    /**
     * Adds a relay to the pool, and sets a timer to remove it if it is not used within the specified time.
     * @param relay - The relay to add to the pool.
     * @param removeIfUnusedAfter - The time in milliseconds to wait before removing the relay from the pool after it is no longer used.
     */
    public useTemporaryRelay(relay: NDKRelay, removeIfUnusedAfter = 600000) {
        const relayAlreadyInPool = this.relays.has(relay.url);

        // check if the relay is already in the pool
        if (!relayAlreadyInPool) {
            this.addRelay(relay);
        }

        // check if the relay already has a disconnecting timer
        const existingTimer = this.temporaryRelayTimers.get(relay.url);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        // add a disconnecting timer only if the relay was not already in the pool
        // or if it had an existing timer
        // this prevents explicit relays from being removed from the pool
        if (!relayAlreadyInPool || existingTimer) {
            // set a timer to remove the relay from the pool if it is not used within the specified time
            const timer = setTimeout(() => {
                this.removeRelay(relay.url);
            }, removeIfUnusedAfter);

            this.temporaryRelayTimers.set(relay.url, timer);
        }
    }

    /**
     * Adds a relay to the pool.
     *
     * @param relay - The relay to add to the pool.
     * @param connect - Whether or not to connect to the relay.
     */
    public addRelay(relay: NDKRelay, connect = true) {
        const relayUrl = relay.url;

        relay.on("notice", (relay, notice) =>
            this.emit("notice", relay, notice)
        );
        relay.on("connect", () => this.handleRelayConnect(relayUrl));
        relay.on("disconnect", () => this.emit("relay:disconnect", relay));
        relay.on("flapping", () => this.handleFlapping(relay));
        this.relays.set(relayUrl, relay);

        if (connect) {
            relay.connect();
        }
    }

    /**
     * Removes a relay from the pool.
     * @param relayUrl - The URL of the relay to remove.
     * @returns {boolean} True if the relay was removed, false if it was not found.
     */
    public removeRelay(relayUrl: string): boolean {
        const relay = this.relays.get(relayUrl);
        if (relay) {
            relay.disconnect();
            this.relays.delete(relayUrl);
            this.emit("relay:disconnect", relay);
            return true;
        }

        // remove the relay from the temporary relay timers
        const existingTimer = this.temporaryRelayTimers.get(relayUrl);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.temporaryRelayTimers.delete(relayUrl);
        }

        return false;
    }

    private handleRelayConnect(relayUrl: string) {
        this.debug(`Relay ${relayUrl} connected`);
        this.emit("relay:connect", this.relays.get(relayUrl));

        if (this.stats().connected === this.relays.size) {
            this.emit("connect");
        }
    }

    /**
     * Attempts to establish a connection to each relay in the pool.
     *
     * @async
     * @param {number} [timeoutMs] - Optional timeout in milliseconds for each connection attempt.
     * @returns {Promise<void>} A promise that resolves when all connection attempts have completed.
     * @throws {Error} If any of the connection attempts result in an error or timeout.
     */
    public async connect(timeoutMs?: number): Promise<void> {
        const promises: Promise<void>[] = [];

        this.debug(
            `Connecting to ${this.relays.size} relays${
                timeoutMs ? `, timeout ${timeoutMs}...` : ""
            }`
        );

        for (const relay of this.relays.values()) {
            if (timeoutMs) {
                const timeoutPromise = new Promise<void>((_, reject) => {
                    setTimeout(
                        () => reject(`Timed out after ${timeoutMs}ms`),
                        timeoutMs
                    );
                });

                promises.push(
                    Promise.race([relay.connect(), timeoutPromise]).catch(
                        (e) => {
                            this.debug(
                                `Failed to connect to relay ${relay.url}: ${e}`
                            );
                        }
                    )
                );
            } else {
                promises.push(relay.connect());
            }
        }

        // If we are running with a timeout, check if we need to emit a `connect` event
        // in case some, but not all, relays were connected
        if (timeoutMs) {
            setTimeout(() => {
                const allConnected =
                    this.stats().connected === this.relays.size;
                const someConnected = this.stats().connected > 0;

                if (!allConnected && someConnected) {
                    this.emit("connect");
                }
            }, timeoutMs);
        }

        await Promise.all(promises);
    }

    private handleFlapping(relay: NDKRelay) {
        this.debug(`Relay ${relay.url} is flapping`);

        // TODO: Be smarter about this.
        this.relays.delete(relay.url);
        this.emit("flapping", relay);
    }

    public size(): number {
        return this.relays.size;
    }

    /**
     * Returns the status of each relay in the pool.
     * @returns {NDKPoolStats} An object containing the number of relays in each status.
     */
    public stats(): NDKPoolStats {
        const stats: NDKPoolStats = {
            total: 0,
            connected: 0,
            disconnected: 0,
            connecting: 0,
        };

        for (const relay of this.relays.values()) {
            stats.total++;
            if (relay.status === NDKRelayStatus.CONNECTED) {
                stats.connected++;
            } else if (relay.status === NDKRelayStatus.DISCONNECTED) {
                stats.disconnected++;
            } else if (relay.status === NDKRelayStatus.CONNECTING) {
                stats.connecting++;
            }
        }

        return stats;
    }

    public connectedRelays(): NDKRelay[] {
        return Array.from(this.relays.values()).filter(
            (relay) => relay.status === NDKRelayStatus.CONNECTED
        );
    }

    /**
     * Get a list of all relay urls in the pool.
     */
    public urls(): string[] {
        return Array.from(this.relays.keys());
    }
}
