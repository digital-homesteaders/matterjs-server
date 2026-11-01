/**
 * @license
 * Copyright 2025-2026 Open Home Foundation
 * SPDX-License-Identifier: Apache-2.0
 */

import { Environment, MockStorageService, NodeId, Observable } from "@matter/main";
import { ClusterId, EndpointNumber, EventId, EventNumber, Priority } from "@matter/main/types";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import type { MatterController } from "../src/controller/MatterController.js";
import type { EventChange } from "../src/controller/PeerChangeBus.js";
import { ConfigStorage } from "../src/server/ConfigStorage.js";
import { WebSocketControllerHandler } from "../src/server/WebSocketControllerHandler.js";

const NODE_ID = NodeId(1);

function createFakeCommandHandler() {
    return {
        events: {
            attributeChanged: new Observable(),
            eventChanged: new Observable<[nodeId: NodeId, data: EventChange]>(),
            nodeAdded: new Observable(),
            nodeStateChanged: new Observable(),
            nodeAvailabilityChanged: new Observable(),
            nodeStructureChanged: new Observable(),
            nodeDecommissioned: new Observable(),
            nodeEndpointAdded: new Observable(),
            nodeEndpointRemoved: new Observable(),
            webRtcCallback: new Observable(),
        },
        getNodeIds: () => [NODE_ID],
        hasNode: () => true,
        formatNode: (nodeId: NodeId) => `test-node-${nodeId}`,
        bleEnabled: false,
        bleProxyEnabled: false,
        getCommissionerNodeId: () => NodeId(112233),
        start: async () => {},
        getCommissionerFabricData: async () => ({ fabricId: 1n, compressedFabricId: 1n, fabricIndex: 1 }),
        initializeNodes: async () => {},
        ensureNodePopulated: async () => {},
        getNodeDetails: () => ({
            node_id: NODE_ID,
            date_commissioned: "2026-01-01T00:00:00",
            last_interview: "2026-01-01T00:00:00",
            interview_version: 6,
            available: true,
            is_bridge: false,
            attributes: {},
            attribute_subscriptions: [],
        }),
    };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error("Timed out");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

describe("event history", () => {
    let httpServer: Server;
    let handler: WebSocketControllerHandler;
    let commandHandler: ReturnType<typeof createFakeCommandHandler>;
    const clients = new Array<WebSocket>();

    beforeEach(async () => {
        const env = new Environment("test");
        new MockStorageService(env);
        const config = await ConfigStorage.create(env);
        commandHandler = createFakeCommandHandler();
        const controller = {
            commandHandler,
            threadDiagnostics: { events: { batchUpdated: new Observable() } },
        } as unknown as MatterController;
        handler = new WebSocketControllerHandler(controller, config, "event-history-test");
        httpServer = createServer();
        await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", () => resolve()));
        await handler.register(httpServer);
    });

    afterEach(async () => {
        for (const client of clients.splice(0)) client.close();
        await handler.unregister().catch(() => undefined);
        await new Promise<void>(resolve => httpServer.close(() => resolve()));
    });

    /** Connects a client that finished `start_listening`; returns the node events it receives. */
    async function listen() {
        const address = httpServer.address();
        if (address === null || typeof address === "string") throw new Error("not listening");
        const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
        clients.push(client);
        const frames = new Array<Record<string, any>>();
        client.on("message", data => frames.push(JSON.parse(data.toString())));
        await new Promise<void>((resolve, reject) => {
            client.once("open", () => resolve());
            client.once("error", reject);
        });
        client.send(JSON.stringify({ message_id: "1", command: "start_listening", args: {} }));
        await waitFor(() => frames.some(frame => frame.message_id === "1"));
        return frames;
    }

    function emitEvent(eventNumber: number) {
        commandHandler.events.eventChanged.emit(NODE_ID, {
            path: { endpointId: EndpointNumber(1), clusterId: ClusterId(0x3b), eventId: EventId(1) },
            events: [
                {
                    eventNumber: EventNumber(BigInt(eventNumber)),
                    priority: Priority.Info,
                    systemTimestamp: Date.now(),
                    data: { newPosition: 1 },
                },
            ],
        });
    }

    it("records each event once with several listening clients", async () => {
        const first = await listen();
        const second = await listen();

        emitEvent(1);
        const isNodeEvent = (frame: Record<string, any>) => frame.event === "node_event";
        await waitFor(() => first.some(isNodeEvent) && second.some(isNodeEvent));

        expect(handler.getEventHistory()).to.have.length(1);
    });

    it("records events while no client is listening", () => {
        emitEvent(1);
        emitEvent(2);

        expect(handler.getEventHistory()).to.have.length(2);
    });

    it("keeps the 25 most recent events", () => {
        for (let eventNumber = 1; eventNumber <= 30; eventNumber++) emitEvent(eventNumber);

        const history = handler.getEventHistory();
        expect(history).to.have.length(25);
        expect(Number(history[0].event_number)).to.equal(6);
    });
});
