/**
 * @license
 * Copyright 2025-2026 Open Home Foundation
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebSocketControllerHandler } from "@matter-server/ws-controller";
import { HealthHandler } from "../src/server/HealthHandler.js";
import { StaticFileHandler } from "../src/server/StaticFileHandler.js";
import { WebServer } from "../src/server/WebServer.js";

const HEALTH = { version: "test", node_count: 3 };

describe("HealthHandler", () => {
    let server: WebServer;
    let base: string;

    before(async () => {
        const wsHandler = { health: () => HEALTH } as unknown as WebSocketControllerHandler;
        // StaticFileHandler is registered as in MatterServer: it reserves /health, so nothing else answers it.
        server = new WebServer({ listenAddresses: ["127.0.0.1"], port: 0 }, [
            new HealthHandler(wsHandler),
            new StaticFileHandler(),
        ]);
        await server.start();
        base = `http://127.0.0.1:${server.port}`;
    });

    after(async () => {
        await server.stop();
    });

    it("answers GET /health", async () => {
        const response = await fetch(`${base}/health`);
        expect(response.status).to.equal(200);
        expect(await response.json()).to.deep.equal(HEALTH);
    });

    it("answers GET /health with a query string", async () => {
        const response = await fetch(`${base}/health?probe=1`, { signal: AbortSignal.timeout(2000) });
        expect(response.status).to.equal(200);
        expect(await response.json()).to.deep.equal(HEALTH);
    });

    it("answers HEAD /health without a body", async () => {
        const response = await fetch(`${base}/health`, { method: "HEAD" });
        expect(response.status).to.equal(200);
        expect(await response.text()).to.equal("");
    });

    it("refuses other methods", async () => {
        const response = await fetch(`${base}/health`, { method: "POST" });
        expect(response.status).to.equal(405);
        expect(response.headers.get("allow")).to.equal("GET, HEAD");
    });
});
