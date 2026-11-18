import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { login } from '../src/auth';
import type { Http } from '../src/http';

// login() uses window timers, as it does inside Obsidian.
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

const neverCalled: Http = () => { throw new Error('no token request expected'); };
const canConnect = (port: number) => new Promise<boolean>(resolve => {
	const s = connect(port, '127.0.0.1');
	s.once('connect', () => { s.destroy(); resolve(true); });
	s.once('error', () => resolve(false));
});

test('cancelling a sign-in rejects it and closes the local listener', async () => {
	const controller = new AbortController();
	let port = 0;
	const pending = login(neverCalled, 'client', url => {
		port = Number(new URL(new URL(url).searchParams.get('redirect_uri')!).port);
	}, controller.signal);
	await new Promise(r => setTimeout(r, 20));
	assert.ok(port > 0);
	assert.equal(await canConnect(port), true, 'listener is open while waiting');
	controller.abort();
	await assert.rejects(pending, /cancelled/);
	assert.equal(await canConnect(port), false, 'listener is closed after cancelling');
});
