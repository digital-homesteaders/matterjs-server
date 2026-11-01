/**
 * @license
 * Copyright 2025-2026 Open Home Foundation
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Bytes, type Channel, ChannelType, type ServerAddress, type Transport } from "@matter/main";
import { Ble, type BlePeripheralInterface, type CommissionableDevice, type Scanner } from "@matter/main/protocol";
import { CombinedBle } from "../src/CombinedBle.js";

function device(peripheralAddress: string, deviceIdentifier = peripheralAddress): CommissionableDevice {
    return {
        deviceIdentifier,
        D: 3840,
        SD: 15,
        CM: 1,
        addresses: [{ type: "ble", peripheralAddress }],
    } as CommissionableDevice;
}

class FakeSide extends Ble {
    readonly opened = new Array<string>();
    readonly closed = { scanner: 0, central: 0 };
    found: CommissionableDevice[];
    discoveryError?: Error;

    constructor(
        readonly name: string,
        found: CommissionableDevice[] = [],
    ) {
        super();
        this.found = found;
    }

    get peripheralInterface(): BlePeripheralInterface {
        return { name: this.name } as unknown as BlePeripheralInterface;
    }

    readonly scanner: Scanner = {
        type: ChannelType.BLE,
        findCommissionableDevicesContinuously: async (_identifier, callback) => {
            if (this.discoveryError) throw this.discoveryError;
            this.found.forEach(callback);
            return this.found;
        },
        getDiscoveredCommissionableDevices: () => this.found,
        cancelCommissionableDeviceDiscovery: () => {},
        close: async () => {
            this.closed.scanner++;
        },
    };

    readonly centralInterface: Transport = {
        onData: () => ({ close: async () => {} }),
        supports: type => type === ChannelType.BLE,
        openChannel: async (address: ServerAddress) => {
            this.opened.push((address as { peripheralAddress: string }).peripheralAddress);
            return { name: this.name } as unknown as Channel<Bytes>;
        },
        close: async () => {
            this.closed.central++;
        },
    };
}

const ble = (peripheralAddress: string): ServerAddress => ({ type: "ble", peripheralAddress });

describe("CombinedBle", () => {
    it("reports the devices both sides find, each peripheral once", async () => {
        const local = new FakeSide("local", [device("AA"), device("BB")]);
        const proxy = new FakeSide("proxy", [device("BB"), device("CC")]);
        const combined = new CombinedBle(local, proxy);

        const reported = new Array<string>();
        const result = await combined.scanner.findCommissionableDevicesContinuously({}, found =>
            reported.push(found.deviceIdentifier),
        );

        expect(reported).to.deep.equal(["AA", "BB", "CC"]);
        expect(result.map(found => found.deviceIdentifier)).to.deep.equal(["AA", "BB", "CC"]);
    });

    it("opens each peripheral on the side that found it, the local adapter when both did", async () => {
        const local = new FakeSide("local", [device("AA"), device("BB")]);
        const proxy = new FakeSide("proxy", [device("BB"), device("CC")]);
        const combined = new CombinedBle(local, proxy);
        await combined.scanner.findCommissionableDevicesContinuously({}, () => {});

        for (const address of ["AA", "BB", "CC"]) {
            await combined.centralInterface.openChannel(ble(address));
        }

        expect(local.opened).to.deep.equal(["AA", "BB"]);
        expect(proxy.opened).to.deep.equal(["CC"]);
    });

    it("routes devices known only from the cache", async () => {
        const proxy = new FakeSide("proxy", [device("CC")]);
        const combined = new CombinedBle(new FakeSide("local"), proxy);

        expect(combined.scanner.getDiscoveredCommissionableDevices({})).to.have.length(1);
        await combined.centralInterface.openChannel(ble("CC"));

        expect(proxy.opened).to.deep.equal(["CC"]);
    });

    it("keeps discovering with one side when the other fails", async () => {
        const local = new FakeSide("local");
        local.discoveryError = new Error("adapter powered off");
        const proxy = new FakeSide("proxy", [device("CC")]);
        const combined = new CombinedBle(local, proxy);

        const result = await combined.scanner.findCommissionableDevicesContinuously({}, () => {});

        expect(result.map(found => found.deviceIdentifier)).to.deep.equal(["CC"]);
    });

    it("fails discovery only when both sides fail", async () => {
        const local = new FakeSide("local");
        local.discoveryError = new Error("adapter powered off");
        const proxy = new FakeSide("proxy");
        proxy.discoveryError = new Error("no proxy connected");
        const combined = new CombinedBle(local, proxy);

        await expect(combined.scanner.findCommissionableDevicesContinuously({}, () => {})).rejectedWith(
            "adapter powered off",
        );
    });

    it("forgets the origin of a commissioned peripheral", async () => {
        const local = new FakeSide("local");
        const proxy = new FakeSide("proxy", [device("CC")]);
        const combined = new CombinedBle(local, proxy);
        await combined.scanner.findCommissionableDevicesContinuously({}, () => {});

        combined.scanner.forgetCommissionedDevice?.([ble("CC")]);
        await combined.centralInterface.openChannel(ble("CC"));

        expect(local.opened).to.deep.equal(["CC"]);
    });

    it("uses the local adapter for peripheral mode", () => {
        const combined = new CombinedBle(new FakeSide("local"), new FakeSide("proxy"));

        expect((combined.peripheralInterface as unknown as { name: string }).name).to.equal("local");
    });

    it("closes both sides", async () => {
        const local = new FakeSide("local");
        const proxy = new FakeSide("proxy");
        const combined = new CombinedBle(local, proxy);
        void combined.centralInterface;

        await combined.close();

        expect([local.closed, proxy.closed]).to.deep.equal([
            { scanner: 1, central: 1 },
            { scanner: 1, central: 1 },
        ]);
    });
});
