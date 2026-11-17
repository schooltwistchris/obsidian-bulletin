// A tiny HTTP seam so the Basecamp code runs both inside Obsidian (requestUrl)
// and in Node tests (fetch).

export interface HttpRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	/** Header names are lowercased. */
	headers: Record<string, string>;
	text: string;
}

export type Http = (req: HttpRequest) => Promise<HttpResponse>;

// Basecamp rejects requests without an app name and contact link.
export const USER_AGENT = 'Bulletin for Obsidian (https://github.com/schooltwistchris/obsidian-bulletin)';

export function lowercaseKeys(h: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
	return out;
}

export class HttpError extends Error {
	constructor(public status: number, public url: string, body: string) {
		super(`Basecamp returned ${status} for ${url.split('?')[0]}: ${body.slice(0, 200)}`);
	}
}
