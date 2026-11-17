import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pull, NoteStore, SyncState } from '../src/sync';
import type { Basecamp, Comment, Message } from '../src/api';

const strip = (h: string) => h.replace(/<[^>]+>/g, '');

function message(id: number, title: string, updated: string, comments = 0): Message {
	return {
		id, title, content: `<div>${title} body</div>`, created_at: '2026-11-01T10:00:00Z', updated_at: updated,
		app_url: `https://3.basecamp.com/1/messages/${id}`, comments_count: comments, comments_url: `c/${id}`,
		creator: { id: 1, name: 'Jane' }, bucket: { id: 9, name: 'Proj' },
	};
}

function fakeBasecamp(pages: Message[][], comments: Record<number, Comment[]> = {}) {
	const calls = { comments: 0, pagesRead: 0 };
	const bc = {
		async *messages() { for (const p of pages) { calls.pagesRead++; yield p; } },
		async comments(m: Message) { calls.comments++; return comments[m.id] ?? []; },
	} as unknown as Basecamp;
	return { bc, calls };
}

function memoryStore() {
	const files = new Map<string, string>();
	const store: NoteStore = {
		read: async p => files.get(p) ?? null,
		write: async (p, c) => { files.set(p, c); },
		rename: async (a, b) => { files.set(b, files.get(a)!); files.delete(a); },
	};
	return { files, store };
}

const opts = { folder: 'Basecamp', projectIds: [] };
const fresh = (): SyncState => ({ notes: {}, cursor: null });

test('first pull writes one note per message and sets the cursor', async () => {
	const { bc } = fakeBasecamp([[message(2, 'B', '2026-11-03T00:00:00Z', 1), message(1, 'A', '2026-11-02T00:00:00Z')]],
		{ 2: [{ id: 5, content: '<div>hi</div>', created_at: '2026-11-03T00:00:00Z', app_url: 'x', creator: { id: 2, name: 'Sam' } }] });
	const { files, store } = memoryStore();
	const state = fresh();
	const r = await pull(bc, store, state, strip, opts);
	assert.equal(r.created.length, 2);
	assert.equal(state.cursor, '2026-11-03T00:00:00Z');
	assert.match(files.get('Basecamp/Proj/Messages/2026-11-01 B.md')!, /## Comments[\s\S]*hi/);
});

test('later pull stops at the cursor', async () => {
	const state = fresh();
	const { store } = memoryStore();
	await pull(fakeBasecamp([[message(1, 'A', '2026-11-02T00:00:00Z')]]).bc, store, state, strip, opts);
	const { bc, calls } = fakeBasecamp([[message(2, 'New', '2026-11-05T00:00:00Z'), message(1, 'A', '2026-11-02T00:00:00Z')], [message(0, 'Old', '2026-10-01T00:00:00Z')]]);
	const r = await pull(bc, store, state, strip, opts);
	assert.deepEqual(r.created, ['Basecamp/Proj/Messages/2026-11-01 New.md']);
	assert.equal(calls.pagesRead, 1, 'second page never requested');
});

test('a note edited in the vault is skipped, not overwritten', async () => {
	const state = fresh();
	const { files, store } = memoryStore();
	await pull(fakeBasecamp([[message(1, 'A', '2026-11-02T00:00:00Z')]]).bc, store, state, strip, opts);
	const path = 'Basecamp/Proj/Messages/2026-11-01 A.md';
	files.set(path, files.get(path) + '\nmy own note\n');
	const r = await pull(fakeBasecamp([[message(1, 'A', '2026-11-04T00:00:00Z')]]).bc, store, state, strip, opts);
	assert.deepEqual(r.skipped, [path]);
	assert.match(files.get(path)!, /my own note/);
});

test('an untouched note is updated, and renamed when the title changes', async () => {
	const state = fresh();
	const { files, store } = memoryStore();
	await pull(fakeBasecamp([[message(1, 'A', '2026-11-02T00:00:00Z')]]).bc, store, state, strip, opts);
	const r = await pull(fakeBasecamp([[message(1, 'A renamed', '2026-11-04T00:00:00Z')]]).bc, store, state, strip, opts);
	assert.deepEqual(r.updated, ['Basecamp/Proj/Messages/2026-11-01 A renamed.md']);
	assert.equal(files.has('Basecamp/Proj/Messages/2026-11-01 A.md'), false);
	assert.match(files.get('Basecamp/Proj/Messages/2026-11-01 A renamed.md')!, /A renamed body/);
});

test('full pull re-checks old messages but leaves unchanged ones alone', async () => {
	const state = fresh();
	const { store } = memoryStore();
	const pages = [[message(1, 'A', '2026-11-02T00:00:00Z', 2)]];
	await pull(fakeBasecamp(pages).bc, store, state, strip, opts);
	const { bc, calls } = fakeBasecamp(pages);
	const r = await pull(bc, store, state, strip, { ...opts, full: true });
	assert.equal(r.unchanged, 1);
	assert.equal(calls.comments, 0, 'no comment fetch for an unchanged message');
});

test('same date and title get distinct files', async () => {
	const { files, store } = memoryStore();
	await pull(fakeBasecamp([[message(2, 'Same', '2026-11-03T00:00:00Z'), message(1, 'Same', '2026-11-02T00:00:00Z')]]).bc, store, fresh(), strip, opts);
	assert.deepEqual([...files.keys()].sort(), ['Basecamp/Proj/Messages/2026-11-01 Same (1).md', 'Basecamp/Proj/Messages/2026-11-01 Same.md']);
});
