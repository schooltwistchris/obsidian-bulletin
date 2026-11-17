// Runs the real pull against Basecamp from Node, writing notes to a folder on disk.
// Usage: tsx scripts/live-pull.mts <token.json> <out-dir> [state.json]
// token.json holds an app.basecamp.com token response; prints counts only.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Basecamp } from '../src/api';
import { Http, lowercaseKeys } from '../src/http';
import { pull, SyncState } from '../src/sync';

const [tokenFile, outDir, stateFile] = process.argv.slice(2);
const tok = JSON.parse(await readFile(tokenFile, 'utf8'));
const http: Http = async req => {
	const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
	return { status: res.status, headers: lowercaseKeys(Object.fromEntries(res.headers)), text: await res.text() };
};
const toMarkdown = (h: string) => h.replace(/<br\s*\/?>/g, '\n').replace(/<\/(p|div|li|h\d)>/g, '\n').replace(/<[^>]+>/g, '');

let calls = 0;
const counting: Http = req => { calls++; return http(req); };
const probe = new Basecamp(counting, async () => tok.access_token);
const account = await probe.account();
const bc = new Basecamp(counting, async () => tok.access_token, account.id);

const state: SyncState = stateFile ? JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{"notes":{},"cursor":null}')) : { notes: {}, cursor: null };
const store = {
	read: (p: string) => readFile(join(outDir, p), 'utf8').catch(() => null),
	write: async (p: string, c: string) => { await mkdir(dirname(join(outDir, p)), { recursive: true }); await writeFile(join(outDir, p), c); },
	rename: async (a: string, b: string) => { await mkdir(dirname(join(outDir, b)), { recursive: true }); await rename(join(outDir, a), join(outDir, b)); },
	findById: async () => null,
};

const t0 = Date.now();
const r = await pull(bc, store, state, toMarkdown, { folder: 'Basecamp', projectIds: [] });
if (stateFile) await writeFile(stateFile, JSON.stringify(state));
console.log(JSON.stringify({
	created: r.created.length, updated: r.updated.length, unchanged: r.unchanged, skipped: r.skipped.length,
	projects: new Set(r.created.concat(r.updated).map(p => p.split('/')[1])).size,
	httpCalls: calls, seconds: Math.round((Date.now() - t0) / 1000), cursorSet: !!state.cursor,
}));
