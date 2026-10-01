import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, fetchBody, HttpError } from "./runtime.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function serve(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer(handler);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}/esbuild`,
		close: () => new Promise<void>((r) => {
			server.closeAllConnections();
			server.close(() => r());
		}),
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stallMs = 300;

test("a body that stops mid-transfer is aborted", async () => {
	const s = await serve((_req, res) => {
		res.writeHead(200);
		res.write("abc");
	});
	try {
		await assert.rejects(fetchBody(s.url, stallMs), /no bytes for 0.3s/);
	} finally {
		await s.close();
	}
});

test("a server that never answers is aborted", async () => {
	const s = await serve(() => {});
	try {
		await assert.rejects(fetchBody(s.url, stallMs), /no bytes for 0.3s/);
	} finally {
		await s.close();
	}
});

test("a transfer longer than the limit succeeds while bytes keep arriving", async () => {
	const s = await serve(async (_req, res) => {
		res.writeHead(200);
		for (let i = 0; i < 10; i++) {
			res.write(String(i));
			await sleep(stallMs / 3);
		}
		res.end();
	});
	try {
		assert.equal((await fetchBody(s.url, stallMs)).toString(), "0123456789");
	} finally {
		await s.close();
	}
});

test("a non-2xx status carries its code", async () => {
	const s = await serve((_req, res) => {
		res.writeHead(404);
		res.end();
	});
	try {
		await assert.rejects(fetchBody(s.url, stallMs), (err: unknown) => err instanceof HttpError && err.status === 404);
	} finally {
		await s.close();
	}
});

test("a refused connection names the network error, not just fetch failed", async () => {
	const s = await serve(() => {});
	const url = s.url;
	await s.close();
	const err = await fetchBody(url, stallMs).then(() => null, (e: unknown) => e);
	assert.match(describe(err), /fetch failed: .*ECONNREFUSED/);
});
