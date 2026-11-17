import type { Basecamp, Message } from './api';
import { hash, isUntouched, notePath, renderNote, ToMarkdown } from './render';

/** The few vault operations a pull needs; Obsidian's vault in the plugin, a Map in tests. */
export interface NoteStore {
	read(path: string): Promise<string | null>;
	/** Creates parent folders as needed. */
	write(path: string, content: string): Promise<void>;
	/** Moves a note, updating links to it. */
	rename(from: string, to: string): Promise<void>;
	/** Path of a note whose basecamp_id property is this ID, if any. */
	findById(id: number): Promise<string | null>;
}

export interface NoteRecord {
	path: string;
	/** Hash of the content this plugin last wrote. */
	hash: string;
	updatedAt: string;
}

export interface SyncState {
	/** Keyed by Basecamp message ID. */
	notes: Record<string, NoteRecord>;
	/** updated_at of the newest message seen by the last completed pull. */
	cursor: string | null;
}

export interface PullOptions {
	folder: string;
	projectIds: number[];
	/** Ignore the cursor and look at every message again. */
	full?: boolean;
	onProgress?: (done: number) => void;
}

export interface PullResult {
	created: string[];
	updated: string[];
	unchanged: number;
	/** Notes edited in the vault since the last pull; left alone. */
	skipped: string[];
}

export async function pull(bc: Basecamp, store: NoteStore, state: SyncState, toMarkdown: ToMarkdown, opts: PullOptions): Promise<PullResult> {
	const result: PullResult = { created: [], updated: [], unchanged: 0, skipped: [] };
	const cursor = opts.full ? null : state.cursor;
	let newest = state.cursor;
	let seen = 0;

	outer:
	for await (const page of bc.messages(opts.projectIds)) {
		for (const msg of page) {
			// Newest-updated first, and comments bump updated_at (spike), so we can stop here.
			if (cursor && msg.updated_at <= cursor) break outer;
			if (!newest || msg.updated_at > newest) newest = msg.updated_at;
			await pullOne(bc, store, state, toMarkdown, opts.folder, msg, result);
			opts.onProgress?.(++seen);
		}
	}

	state.cursor = newest;
	return result;
}

async function pullOne(bc: Basecamp, store: NoteStore, state: SyncState, toMarkdown: ToMarkdown, folder: string, msg: Message, result: PullResult) {
	const key = String(msg.id);
	const record = state.notes[key];
	if (record && record.updatedAt === msg.updated_at && (await store.read(record.path)) !== null) {
		result.unchanged++;
		return;
	}

	const comments = msg.comments_count ? await bc.comments(msg) : [];
	const content = renderNote(msg, comments, toMarkdown);
	let target = notePath(folder, msg);

	if (record) {
		const current = await store.read(record.path);
		if (current !== null) {
			if (hash(current) !== record.hash) {
				result.skipped.push(record.path);
				return;
			}
			if (record.path !== target) {
				target = await freePath(store, target, msg.id);
				await store.rename(record.path, target);
			} else {
				target = record.path;
			}
			await store.write(target, content);
			state.notes[key] = { path: target, hash: hash(content), updatedAt: msg.updated_at };
			result.updated.push(target);
			return;
		}
	}

	// No note where the record says (or no record, e.g. after a reinstall). Look for one Bulletin
	// wrote earlier before creating another.
	const existing = await store.findById(msg.id);
	if (existing !== null) {
		const current = await store.read(existing);
		// Take it over only if it's provably untouched: identical to what we'd write now, still matching
		// the fingerprint inside it, or what we last wrote and then moved. Otherwise it may hold the
		// user's edits, so leave it alone.
		if (current !== null && current !== content && !isUntouched(current) && hash(current) !== record?.hash) {
			result.skipped.push(existing);
			return;
		}
		if (current !== content) await store.write(existing, content);
		state.notes[key] = { path: existing, hash: hash(content), updatedAt: msg.updated_at };
		if (current === content) result.unchanged++;
		else result.updated.push(existing);
		return;
	}

	target = await freePath(store, target, msg.id);
	await store.write(target, content);
	state.notes[key] = { path: target, hash: hash(content), updatedAt: msg.updated_at };
	result.created.push(target);
}

/** Two messages with the same date and title would collide; add the ID to the second. */
async function freePath(store: NoteStore, path: string, id: number): Promise<string> {
	if ((await store.read(path)) === null) return path;
	return path.replace(/\.md$/, ` (${id}).md`);
}
