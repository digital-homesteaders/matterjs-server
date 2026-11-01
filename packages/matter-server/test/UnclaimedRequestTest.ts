/**
 * @license
 * Copyright 2025-2026 Open Home Foundation
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HttpServer, WebServerHandler, WebSocketControllerHandler } from "@matter-server/ws-controller";
import { HealthHandler } from "../src/server/HealthHandler.js";
import { StaticFileHandler } from "../src/server/StaticFileHandler.js";
import { WebServer } from "../src/server/WebServer.js";

/** Claims /slow and answers it only after the fallback would already have run. */
class SlowHandler implements WebServerHandler {
    async register(server: HttpServer) {
        server.on("request", (req, res) => {
            if (req.url !== "/slow") return;
            (req as { _matterHandledRequest?: boolean })._matterHandledRequest = true;
            setTimeout(() => res.end("slow"), 50);
        });
    }

    async unregister() {}
}

const wsHandler = { health: () => ({ version: "test", node_count: 0 }) } as unknown as WebSocketControllerHandler;

async function statusOf(base: string, path: string) {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(2000) });
    return { status: response.status, body: await response.text() };
}

describe("unclaimed HTTP requests", () => {
    describe("with the dashboard", () => {
        let server: WebServer;
        let base: string;

        before(async () => {
            server = new WebServer({ listenAddresses: ["127.0.0.1"], port: 0 }, [
                new HealthHandler(wsHandler),
                new SlowHandler(),
                new StaticFileHandler(false, ["/slow"]),
            ]);
            await server.start();
            base = `http://127.0.0.1:${server.port}`;
        });

        after(async () => {
            await server.stop();
        });

        for (const path of ["/ws", "/ws/", "/health/", "/health/x"]) {
            it(`answers reserved but unhandled ${path} with 404`, async () => {
                expect((await statusOf(base, path)).status).to.equal(404);
            });
        }

        it("leaves a request a handler claimed and answers later", async () => {
            expect(await statusOf(base, "/slow")).to.deep.equal({ status: 200, body: "slow" });
        });

        it("still serves /health and the dashboard", async () => {
            expect((await statusOf(base, "/health")).status).to.equal(200);
            expect((await statusOf(base, "/")).status).to.equal(200);
        });
    });

    describe("without the dashboard", () => {
        let server: WebServer;
        let base: string;

        before(async () => {
            server = new WebServer({ listenAddresses: ["127.0.0.1"], port: 0 }, [new HealthHandler(wsHandler)]);
            await server.start();
            base = `http://127.0.0.1:${server.port}`;
        });

        after(async () => {
            await server.stop();
        });

        for (const path of ["/", "/index.html", "/unknown"]) {
            it(`answers ${path} with 404`, async () => {
                expect((await statusOf(base, path)).status).to.equal(404);
            });
        }
    });
});
