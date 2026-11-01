/**
 * @license
 * Copyright 2025-2026 Open Home Foundation
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    type Bytes,
    type Channel,
    ChannelType,
    type Duration,
    type Environment,
    Logger,
    ServerAddress,
    type Transport,
} from "@matter/main";
import {
    Ble,
    type BlePeripheralInterface,
    type CommissionableDevice,
    type CommissionableDeviceIdentifiers,
    type CommissionableDeviceIdentity,
    type Scanner,
} from "@matter/main/protocol";

const logger = Logger.get("CombinedBle");

type Side = "local" | "proxy";

/**
 * Uses a local Bluetooth adapter and the BLE proxy at the same time. matter.js holds a single {@link Ble}, so this
 * one scans with both and opens each connection on the side that discovered the peripheral, the local adapter when
 * both did. Peripheral mode is the local adapter's; the proxy has none.
 */
export class CombinedBle extends Ble {
    readonly #local: Ble;
    readonly #proxy: Ble;
    readonly #origins = new Map<string, Side>();
    #scanner?: CombinedBleScanner;
    #centralInterface?: CombinedBleCentralInterface;

    /** Pairs the proxy with the local adapter that `ble.hci.id` selects. */
    static async create(environment: Environment, proxy: Ble): Promise<CombinedBle> {
        // The import installs matter.js's own NodeJsBle for ble.enable, so the caller must set this one after it.
        const { NodeJsBle } = await import("@matter/nodejs-ble");
        return new CombinedBle(new NodeJsBle({ environment }), proxy);
    }

    constructor(local: Ble, proxy: Ble) {
        super();
        this.#local = local;
        this.#proxy = proxy;
    }

    get peripheralInterface(): BlePeripheralInterface {
        return this.#local.peripheralInterface;
    }

    get scanner(): Scanner {
        return (this.#scanner ??= new CombinedBleScanner(this.#local.scanner, this.#proxy.scanner, this.#origins));
    }

    get centralInterface(): Transport {
        // Each central resolves the peripheral through its own scanner, so that one must exist first.
        void this.scanner;
        return (this.#centralInterface ??= new CombinedBleCentralInterface(
            this.#local.centralInterface,
            this.#proxy.centralInterface,
            this.#origins,
        ));
    }

    async close(): Promise<void> {
        await Promise.allSettled([this.#centralInterface?.close(), this.#scanner?.close()]);
    }
}

function bleAddressesOf(device: CommissionableDevice) {
    return device.addresses.filter(ServerAddress.isBle).map(address => address.peripheralAddress);
}

export class CombinedBleScanner implements Scanner {
    readonly type = ChannelType.BLE;
    readonly #local: Scanner;
    readonly #proxy: Scanner;
    readonly #origins: Map<string, Side>;

    constructor(local: Scanner, proxy: Scanner, origins: Map<string, Side>) {
        this.#local = local;
        this.#proxy = proxy;
        this.#origins = origins;
    }

    #record(device: CommissionableDevice, side: Side) {
        for (const address of bleAddressesOf(device)) {
            if (side === "local" || !this.#origins.has(address)) {
                this.#origins.set(address, side);
            }
        }
    }

    /** One entry per peripheral; the local adapter's record wins over the proxy's. */
    #merge(local: CommissionableDevice[], proxy: CommissionableDevice[]) {
        const seen = new Set<string>();
        const merged = new Array<CommissionableDevice>();
        for (const device of [...local, ...proxy]) {
            const addresses = bleAddressesOf(device);
            if (addresses.length > 0 && addresses.every(address => seen.has(address))) continue;
            addresses.forEach(address => seen.add(address));
            merged.push(device);
        }
        return merged;
    }

    async findCommissionableDevicesContinuously(
        identifier: CommissionableDeviceIdentifiers,
        callback: (device: CommissionableDevice) => void,
        timeout?: Duration,
        cancelSignal?: Promise<void>,
    ): Promise<CommissionableDevice[]> {
        const reported = new Set<string>();
        const forward = (side: Side) => (device: CommissionableDevice) => {
            this.#record(device, side);
            const addresses = bleAddressesOf(device);
            if (addresses.length > 0 && addresses.every(address => reported.has(address))) return;
            addresses.forEach(address => reported.add(address));
            callback(device);
        };
        const [local, proxy] = await Promise.allSettled([
            this.#local.findCommissionableDevicesContinuously(identifier, forward("local"), timeout, cancelSignal),
            this.#proxy.findCommissionableDevicesContinuously(identifier, forward("proxy"), timeout, cancelSignal),
        ]);
        if (local.status === "rejected" && proxy.status === "rejected") {
            throw local.reason;
        }
        for (const [side, result] of [
            ["local", local],
            ["proxy", proxy],
        ] as const) {
            if (result.status === "rejected") {
                logger.warn(`BLE discovery via the ${side} side failed:`, result.reason);
            }
        }
        return this.#merge(
            local.status === "fulfilled" ? local.value : [],
            proxy.status === "fulfilled" ? proxy.value : [],
        );
    }

    getDiscoveredCommissionableDevices(identifier: CommissionableDeviceIdentifiers): CommissionableDevice[] {
        const local = this.#local.getDiscoveredCommissionableDevices(identifier);
        const proxy = this.#proxy.getDiscoveredCommissionableDevices(identifier);
        proxy.forEach(device => this.#record(device, "proxy"));
        local.forEach(device => this.#record(device, "local"));
        return this.#merge(local, proxy);
    }

    cancelCommissionableDeviceDiscovery(identifier: CommissionableDeviceIdentifiers, resolvePromise?: boolean): void {
        this.#local.cancelCommissionableDeviceDiscovery(identifier, resolvePromise);
        this.#proxy.cancelCommissionableDeviceDiscovery(identifier, resolvePromise);
    }

    forgetCommissionedDevice(addresses: readonly ServerAddress[], identity?: CommissionableDeviceIdentity): void {
        this.#local.forgetCommissionedDevice?.(addresses, identity);
        this.#proxy.forgetCommissionedDevice?.(addresses, identity);
        for (const address of addresses) {
            if (ServerAddress.isBle(address)) this.#origins.delete(address.peripheralAddress);
        }
    }

    async close(): Promise<void> {
        await Promise.allSettled([this.#local.close(), this.#proxy.close()]);
    }
}

export class CombinedBleCentralInterface implements Transport {
    readonly #local: Transport;
    readonly #proxy: Transport;
    readonly #origins: Map<string, Side>;

    constructor(local: Transport, proxy: Transport, origins: Map<string, Side>) {
        this.#local = local;
        this.#proxy = proxy;
        this.#origins = origins;
    }

    onData(listener: (socket: Channel<Bytes>, data: Bytes) => void): Transport.Listener {
        const listeners = [this.#local.onData(listener), this.#proxy.onData(listener)];
        return {
            close: async () => {
                await Promise.allSettled(listeners.map(entry => entry.close()));
            },
        };
    }

    supports(type: ChannelType, address?: string): boolean {
        return this.#local.supports(type, address) || this.#proxy.supports(type, address);
    }

    openChannel(address: ServerAddress, options?: Transport.OpenChannelOptions): Promise<Channel<Bytes>> {
        const side = ServerAddress.isBle(address) ? this.#origins.get(address.peripheralAddress) : undefined;
        if (side === undefined) {
            logger.debug(
                `BLE peripheral ${ServerAddress.urlFor(address)} was not discovered, trying the local adapter`,
            );
        }
        return (side === "proxy" ? this.#proxy : this.#local).openChannel(address, options);
    }

    async close(): Promise<void> {
        await Promise.allSettled([this.#local.close(), this.#proxy.close()]);
    }
}
