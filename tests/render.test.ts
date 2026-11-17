import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUntouched, notePath, prepareHtml, renderNote, sanitizeFilename } from '../src/render';
import type { Message } from '../src/api';

const mention = `<bc-attachment sgid="x" content-type="application/vnd.basecamp.mention" content='&lt;bc-mention&gt;Jane&lt;/bc-mention&gt;'><figure>
  <img src="https://example.com/a.png" width="16" height="16">
  <figcaption>Jane Doe</figcaption>
</figure></bc-attachment>`;
const image = `<bc-attachment sgid="y" content-type="image/png" url="https://storage.example/u" href="https://3.basecamp.com/1/blobs/abc/download/pic.png" filename="pic.png" caption="Front &amp; back"><figure>
    <img src="https://preview.example/pic.png">
  <figcaption>Front &amp; back</figcaption>
</figure></bc-attachment>`;

test('mentions become @Name', () => {
	assert.equal(prepareHtml(`<div>Hi ${mention}!</div>`), '<div>Hi @Jane Doe!</div>');
});

test('attachments become links to Basecamp, captions escaped', () => {
	assert.equal(prepareHtml(image), '<a href="https://3.basecamp.com/1/blobs/abc/download/pic.png">Front &amp; back</a>');
});

test('<mark> becomes ==highlight==', () => {
	assert.equal(prepareHtml('<mark style="x">big</mark> deal'), '==big== deal');
});

test('filenames lose characters vaults and links choke on', () => {
	assert.equal(sanitizeFilename('Q4: plan / [draft] #2?'), 'Q4 plan draft 2');
	assert.equal(sanitizeFilename('...'), 'Untitled');
});

const msg: Message = {
	id: 42, title: 'Launch "plan"', content: '<div>Body</div>', created_at: '2026-11-14T18:52:00Z', updated_at: '2026-11-15T09:10:00Z',
	app_url: 'https://3.basecamp.com/1/buckets/2/messages/42', comments_count: 1, comments_url: 'u',
	creator: { id: 1, name: 'Jane' }, bucket: { id: 2, name: 'Marketing/Ops' },
};

test('note path is folder/project/Messages/date title', () => {
	assert.equal(notePath('Basecamp', msg), 'Basecamp/Marketing Ops/Messages/2026-11-14 Launch plan.md');
});

test('note has quoted frontmatter, body and comments', () => {
	const strip = (h: string) => h.replace(/<[^>]+>/g, '');
	const note = renderNote(msg, [{ id: 7, content: '<div>Nice</div>', created_at: '2026-11-14T19:02:00Z', app_url: 'https://c', creator: { id: 3, name: 'Sam' } }], strip);
	assert.match(note, /^---\nbasecamp_id: 42\nbasecamp_url: "https:\/\/3\.basecamp\.com/);
	assert.match(note, /\nproject: "Marketing\/Ops"\n/);
	assert.match(note, /\n# Launch "plan"\n\nBody\n\n## Comments\n\n\*\*Sam\*\* · \[Nov 14, 2026, \d+:02 [AP]M\]\(https:\/\/c\)\n\nNice\n$/);
});

test('notes carry a fingerprint that notices edits', () => {
	const note = renderNote({
		id: 1, title: 'T', content: '<div>body</div>', created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-01T10:00:00Z',
		app_url: 'u', comments_count: 0, comments_url: 'c', creator: { id: 1, name: 'Jane' }, bucket: { id: 9, name: 'P' },
	}, [], h => h.replace(/<[^>]+>/g, ''));
	assert.match(note, /\nbulletin_hash: "[0-9a-f]+"\n---\n/);
	assert.equal(isUntouched(note), true);
	assert.equal(isUntouched(note.replace('body', 'body edited')), false);
	assert.equal(isUntouched(note.replace(/bulletin_hash.*\n/, '')), false);
});
