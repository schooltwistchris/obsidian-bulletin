// Sign-in with Basecamp's first-party OAuth server (app.basecamp.com).
//
// The plugin registers itself as a public client (no secret), then logs in with
// authorization code + PKCE, receiving the code on a loopback listener at a random
// port. See basecamp-pull-scope.md, "Spike results", for why this flow was chosen.

import * as http from 'http';
import { Http, HttpError, USER_AGENT } from './http';

const AS = 'https://app.basecamp.com';
const REGISTERED_REDIRECT = 'http://127.0.0.1/callback';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface Tokens {
	accessToken: string;
	refreshToken: string;
	/** Epoch milliseconds. */
	expiresAt: number;
}

export async function registerClient(fetch: Http): Promise<string> {
	const res = await fetch({
		url: `${AS}/oauth/clients`,
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, Accept: 'application/json' },
		body: JSON.stringify({
			client_name: 'Bulletin for Obsidian',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
			scope: 'read',
			redirect_uris: [REGISTERED_REDIRECT],
		}),
	});
	if (res.status >= 300) throw new HttpError(res.status, `${AS}/oauth/clients`, res.text);
	const { client_id: clientId } = JSON.parse(res.text) as { client_id?: string };
	if (!clientId) throw new Error('Basecamp did not return a client ID.');
	return clientId;
}

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Bulletin</title>
<body style="font-family:system-ui;padding:3em;text-align:center">
<h2>Connected</h2><p>You can close this tab and go back to Obsidian.</p></body>`;

/** Runs the browser login and resolves with tokens. */
export async function login(fetch: Http, clientId: string, openBrowser: (url: string) => void): Promise<Tokens> {
	const { verifier, challenge } = await pkce();
	const state = base64url(crypto.getRandomValues(new Uint8Array(16)));

	const server = http.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});
	const port = (server.address() as { port: number }).port;
	const redirectUri = `http://127.0.0.1:${port}/callback`;

	try {
		const codePromise = new Promise<string>((resolve, reject) => {
			const timer = window.setTimeout(() => reject(new Error('Login timed out. Try connecting again.')), LOGIN_TIMEOUT_MS);
			server.on('request', (req, res) => {
				const url = new URL(req.url ?? '/', redirectUri);
				if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
				const error = url.searchParams.get('error');
				const code = url.searchParams.get('code');
				const ok = !error && code && url.searchParams.get('state') === state;
				res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(ok ? DONE_PAGE : '<p>Login failed. Go back to Obsidian and try again.</p>');
				window.clearTimeout(timer);
				if (ok) resolve(code);
				else reject(new Error(error ? `Basecamp refused the login: ${error}` : 'Login callback did not match.'));
			});
		});

		const params = new URLSearchParams({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: redirectUri,
			scope: 'read',
			state,
			code_challenge: challenge,
			code_challenge_method: 'S256',
		});
		openBrowser(`${AS}/oauth/authorizations/new?${params}`);
		const code = await codePromise;

		return await tokenRequest(fetch, {
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
			client_id: clientId,
			code_verifier: verifier,
		});
	} finally {
		server.close();
	}
}

export function refresh(fetch: Http, clientId: string, refreshToken: string): Promise<Tokens> {
	return tokenRequest(fetch, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
}

async function tokenRequest(fetch: Http, form: Record<string, string>): Promise<Tokens> {
	const url = `${AS}/oauth/tokens`;
	const res = await fetch({
		url,
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': USER_AGENT },
		body: new URLSearchParams(form).toString(),
	});
	if (res.status >= 300) throw new HttpError(res.status, url, res.text);
	const t = JSON.parse(res.text) as { access_token: string; refresh_token?: string; expires_in?: number };
	return {
		accessToken: t.access_token,
		// Refresh tokens rotate: always keep the newest one.
		refreshToken: t.refresh_token ?? form.refresh_token,
		expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
	};
}
