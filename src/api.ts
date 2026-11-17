import { Http, HttpError, USER_AGENT } from './http';

const API = 'https://3.basecampapi.com';
const MAX_RETRIES = 5;

export interface Person { id: number; name: string }

export interface Message {
	id: number;
	title: string;
	content: string;
	created_at: string;
	updated_at: string;
	app_url: string;
	comments_count: number;
	comments_url: string;
	creator: Person;
	bucket: { id: number; name: string };
	category?: { name: string } | null;
}

export interface Comment {
	id: number;
	content: string;
	created_at: string;
	app_url: string;
	creator: Person;
}

export interface Project { id: number; name: string }

export interface Account { id: number; name: string; href: string }

export class Basecamp {
	constructor(private fetch: Http, private getToken: () => Promise<string>, private accountId?: number) {}

	private async get<T>(url: string): Promise<{ data: T; headers: Record<string, string> }> {
		for (let attempt = 0; ; attempt++) {
			const res = await this.fetch({
				url,
				headers: {
					Authorization: `Bearer ${await this.getToken()}`,
					'User-Agent': USER_AGENT,
					Accept: 'application/json',
				},
			});
			if (res.status === 429 && attempt < MAX_RETRIES) {
				// API limit seen in the spike: 50 requests per 10 seconds.
				const wait = Number(res.headers['retry-after']) || 10;
				await new Promise(r => window.setTimeout(r, wait * 1000));
				continue;
			}
			if (res.status >= 300) throw new HttpError(res.status, url, res.text);
			return { data: JSON.parse(res.text) as T, headers: res.headers };
		}
	}

	private async *pages<T>(url: string): AsyncGenerator<T[]> {
		let next: string | null = url;
		while (next) {
			const { data, headers }: { data: T[]; headers: Record<string, string> } = await this.get<T[]>(next);
			yield data;
			next = /<([^>]+)>;\s*rel="next"/.exec(headers['link'] ?? '')?.[1] ?? null;
		}
	}

	private base(): string {
		if (!this.accountId) throw new Error('No Basecamp account selected.');
		return `${API}/${this.accountId}`;
	}

	/** Tokens from app.basecamp.com are bound to the one account picked at login. */
	async account(): Promise<Account> {
		const { data } = await this.get<{ accounts?: (Account & { product: string })[] }>(`${API}/authorization.json`);
		const accounts = (data.accounts ?? []).filter(a => a.product === 'bc3');
		if (!accounts.length) throw new Error('This login has no Basecamp account.');
		return accounts[0];
	}

	async projects(): Promise<Project[]> {
		const out: Project[] = [];
		for await (const page of this.pages<Project>(`${this.base()}/projects.json`)) out.push(...page);
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Every active message the user can see, most recently updated first. */
	messages(projectIds?: number[]): AsyncGenerator<Message[]> {
		const q = new URLSearchParams({ type: 'Message', sort: 'updated_at', direction: 'desc' });
		if (projectIds?.length) q.set('bucket', projectIds.join(','));
		return this.pages<Message>(`${this.base()}/projects/recordings.json?${q}`);
	}

	async comments(message: Message): Promise<Comment[]> {
		const out: Comment[] = [];
		for await (const page of this.pages<Comment>(message.comments_url)) out.push(...page);
		return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
	}
}
