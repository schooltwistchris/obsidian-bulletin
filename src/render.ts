import type { Comment, Message } from './api';

export type ToMarkdown = (html: string) => string;

function attr(tag: string, name: string): string {
	const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
	return m ? decodeEntities(m[1]) : '';
}

function decodeEntities(s: string): string {
	return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Rewrites Basecamp-only markup into plain HTML that a generic HTML-to-Markdown
 * converter handles:
 * - mentions become "@Name"
 * - attachments (images, files) become links to Basecamp (v1 doesn't download them)
 * - <mark> becomes Obsidian's ==highlight==
 */
export function prepareHtml(html: string): string {
	return html
		.replace(/<bc-attachment\b([^>]*)>([\s\S]*?)<\/bc-attachment>/g, (_all, attrs: string, inner: string) => {
			const tag = `<x ${attrs}>`;
			const type = attr(tag, 'content-type');
			if (type === 'application/vnd.basecamp.mention') {
				const name = /<figcaption>([\s\S]*?)<\/figcaption>/.exec(inner)?.[1]?.trim() || attr(tag, 'title') || 'someone';
				return `@${name}`;
			}
			const href = attr(tag, 'href') || attr(tag, 'url');
			const label = attr(tag, 'caption') || attr(tag, 'filename') || 'Attachment';
			return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : escapeHtml(label);
		})
		.replace(/<mark\b[^>]*>([\s\S]*?)<\/mark>/g, '==$1==');
}

export function sanitizeFilename(s: string): string {
	const clean = s.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
	return (clean || 'Untitled').slice(0, 100).trim();
}

export function notePath(folder: string, msg: Message): string {
	const date = msg.created_at.slice(0, 10);
	return `${folder}/${sanitizeFilename(msg.bucket.name)}/Messages/${date} ${sanitizeFilename(msg.title)}.md`;
}

function yaml(v: string | number): string {
	return typeof v === 'number' ? String(v) : JSON.stringify(v);
}

function when(iso: string): string {
	const d = new Date(iso);
	return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function renderNote(msg: Message, comments: Comment[], toMarkdown: ToMarkdown): string {
	const fm: [string, string | number][] = [
		['basecamp_id', msg.id],
		['basecamp_url', msg.app_url],
		['project', msg.bucket.name],
		['author', msg.creator.name],
	];
	if (msg.category?.name) fm.push(['category', msg.category.name]);
	fm.push(['created', msg.created_at], ['updated', msg.updated_at], ['comments', comments.length]);

	// cssclasses lets themes style Bulletin's notes without guessing which notes they are.
	const out = ['---', ...fm.map(([k, v]) => `${k}: ${yaml(v)}`), 'cssclasses:', '  - bulletin', '---', '', `# ${msg.title}`, ''];
	out.push(toMarkdown(prepareHtml(msg.content ?? '')).trim(), '');

	if (comments.length) {
		out.push('## Comments', '');
		// Each comment is a callout, so it reads as its own entry in editing and reading view alike.
		for (const c of comments) {
			const body = toMarkdown(prepareHtml(c.content ?? '')).trim();
			out.push(`> [!comment] **${c.creator.name}** · [${when(c.created_at)}](${c.app_url})`);
			if (body) out.push(...body.split('\n').map(line => (line ? `> ${line}` : '>')));
			out.push('');
		}
	}
	const note = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
	// Fingerprint of the note as written, kept in the note so it survives a reinstall.
	return note.replace(/\n---\n/, `\nbulletin_hash: "${hash(note)}"\n---\n`);
}

const HASH_LINE = /^bulletin_hash: "([0-9a-f]+)"\n/m;

/** True if the note still matches the fingerprint Bulletin wrote into it. */
export function isUntouched(content: string): boolean {
	const m = HASH_LINE.exec(content);
	return !!m && hash(content.replace(HASH_LINE, '')) === m[1];
}

/** Cheap content fingerprint, used to notice local edits. */
export function hash(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}
