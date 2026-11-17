import { App, htmlToMarkdown, normalizePath, Notice, Plugin, PluginSettingTab, requestUrl, SettingDefinitionItem, SettingGroupItem, TFile } from 'obsidian';
import { Basecamp, Project } from './api';
import { login, refresh, registerClient, Tokens } from './auth';
import { Http, lowercaseKeys } from './http';
import { NoteStore, pull, SyncState } from './sync';

const TOKEN_SECRET_ID = 'bulletin-tokens';

interface Settings {
	folder: string;
	/** Empty means every project. */
	projectIds: number[];
	clientId: string | null;
	accountId: number | null;
	accountName: string | null;
}

interface Data {
	settings: Settings;
	state: SyncState;
}

const DEFAULTS: Data = {
	settings: { folder: 'Basecamp', projectIds: [], clientId: null, accountId: null, accountName: null },
	state: { notes: {}, cursor: null },
};

const obsidianHttp: Http = async req => {
	const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
	return { status: res.status, headers: lowercaseKeys(res.headers), text: res.text };
};

export default class BulletinPlugin extends Plugin {
	data: Data = structuredClone(DEFAULTS);
	private pulling = false;
	private refreshing: Promise<string> | null = null;

	async onload() {
		const saved = (await this.loadData()) as Partial<Data> | null;
		this.data = {
			settings: { ...DEFAULTS.settings, ...saved?.settings },
			state: { ...DEFAULTS.state, ...saved?.state },
		};

		this.addCommand({ id: 'pull', name: 'Pull new and changed messages', callback: () => this.runPull(false) });
		this.addCommand({ id: 'pull-full', name: 'Check every message again', callback: () => this.runPull(true) });
		this.addSettingTab(new SettingsTab(this.app, this));
	}

	async save() {
		await this.saveData(this.data);
	}

	// ---- Tokens (kept in Obsidian's secret storage, never in data.json) ----

	private readTokens(): Tokens | null {
		const raw = this.app.secretStorage.getSecret(TOKEN_SECRET_ID);
		if (!raw) return null;
		try { return JSON.parse(raw) as Tokens; } catch { return null; }
	}

	private writeTokens(t: Tokens | null) {
		this.app.secretStorage.setSecret(TOKEN_SECRET_ID, t ? JSON.stringify(t) : '');
	}

	isConnected(): boolean {
		return !!this.readTokens() && !!this.data.settings.accountId;
	}

	private getToken = async (): Promise<string> => {
		const t = this.readTokens();
		if (!t) throw new Error('Not connected to Basecamp.');
		if (t.expiresAt - 60_000 > Date.now()) return t.accessToken;
		// One refresh at a time: refresh tokens rotate, so a second concurrent refresh would fail.
		this.refreshing ??= (async () => {
			try {
				const next = await refresh(obsidianHttp, this.data.settings.clientId!, t.refreshToken);
				this.writeTokens(next);
				return next.accessToken;
			} finally {
				this.refreshing = null;
			}
		})();
		return this.refreshing;
	};

	client(): Basecamp {
		return new Basecamp(obsidianHttp, this.getToken, this.data.settings.accountId ?? undefined);
	}

	async connect() {
		const s = this.data.settings;
		if (!s.clientId) {
			s.clientId = await registerClient(obsidianHttp);
			await this.save();
		}
		new Notice('Approve access in your browser, then come back here.');
		const tokens = await login(obsidianHttp, s.clientId, url => window.open(url));
		this.writeTokens(tokens);
		const account = await this.client().account();
		if (s.accountId !== account.id) {
			// A different account: notes from the old one stay, but start the cursor over.
			this.data.state.cursor = null;
			s.projectIds = [];
		}
		s.accountId = account.id;
		s.accountName = account.name;
		await this.save();
		new Notice(`Connected to ${account.name}.`);
	}

	async disconnect() {
		this.writeTokens(null);
		this.data.settings.accountId = null;
		this.data.settings.accountName = null;
		await this.save();
	}

	// ---- Pull ----

	private store(): NoteStore {
		const vault = this.app.vault;
		let byId: Map<number, string> | null = null;
		return {
			findById: async id => {
				// Built once per pull from Obsidian's metadata cache; no file reads.
				if (!byId) {
					byId = new Map();
					for (const f of vault.getMarkdownFiles()) {
						const bcId: unknown = this.app.metadataCache.getFileCache(f)?.frontmatter?.basecamp_id;
						if (typeof bcId === 'number') byId.set(bcId, f.path);
					}
				}
				return byId.get(id) ?? null;
			},
			read: async path => {
				const f = vault.getAbstractFileByPath(normalizePath(path));
				return f instanceof TFile ? vault.read(f) : null;
			},
			write: async (path, content) => {
				path = normalizePath(path);
				const f = vault.getAbstractFileByPath(path);
				if (f instanceof TFile) { await vault.process(f, () => content); return; }
				const dir = path.split('/').slice(0, -1).join('/');
				if (dir && !vault.getAbstractFileByPath(dir)) await vault.createFolder(dir).catch(() => {});
				await vault.create(path, content);
			},
			rename: async (from, to) => {
				const f = vault.getAbstractFileByPath(normalizePath(from));
				if (!(f instanceof TFile)) return;
				const dir = to.split('/').slice(0, -1).join('/');
				if (dir && !vault.getAbstractFileByPath(dir)) await vault.createFolder(dir).catch(() => {});
				await this.app.fileManager.renameFile(f, normalizePath(to));
			},
		};
	}

	async runPull(full: boolean) {
		if (!this.isConnected()) { new Notice('Connect to Basecamp first, in Settings → Bulletin.'); return; }
		if (this.pulling) { new Notice('A pull is already running.'); return; }
		this.pulling = true;
		const progress = new Notice('Pulling Basecamp messages…', 0);
		try {
			const r = await pull(this.client(), this.store(), this.data.state, htmlToMarkdown, {
				folder: normalizePath(this.data.settings.folder || 'Basecamp'),
				projectIds: this.data.settings.projectIds,
				full,
				onProgress: n => progress.setMessage(`Pulling Basecamp messages… ${n}`),
			});
			const parts = [`${r.created.length} new`, `${r.updated.length} updated`];
			if (r.unchanged) parts.push(`${r.unchanged} unchanged`);
			if (r.skipped.length) parts.push(`${r.skipped.length} skipped because you edited them`);
			new Notice(`Basecamp: ${parts.join(', ')}.`, 8000);
		} catch (e) {
			console.error('Bulletin: pull failed', e);
			new Notice(`Basecamp pull failed: ${(e as Error).message}`, 10000);
		} finally {
			progress.hide();
			this.pulling = false;
			await this.save();
		}
	}
}

class SettingsTab extends PluginSettingTab {
	private projects: Project[] | null = null;
	private projectsError: string | null = null;
	private loadingProjects = false;

	constructor(app: App, private plugin: BulletinPlugin) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.data.settings;
		const connected = this.plugin.isConnected();
		const items: SettingDefinitionItem[] = [
			{
				name: 'Basecamp account',
				desc: connected
					? `Connected to ${s.accountName}. Read-only access.`
					: 'Opens Basecamp in your browser to approve read-only access to one account.',
				render: setting => {
					if (connected) {
						setting.addButton(b => b.setButtonText('Disconnect').onClick(async () => {
							await this.plugin.disconnect();
							this.projects = null;
							this.update();
						}));
					} else {
						setting.addButton(b => b.setButtonText('Connect').setCta().onClick(async () => {
							b.setDisabled(true).setButtonText('Waiting for browser…');
							try { await this.plugin.connect(); }
							catch (e) { new Notice(`Couldn't connect: ${(e as Error).message}`, 10000); }
							this.update();
						}));
					}
				},
			},
			{
				name: 'Folder',
				desc: 'Messages go in <folder>/<project>/Messages/.',
				control: { type: 'text', key: 'folder', placeholder: 'Basecamp' },
			},
		];
		if (!connected) return items;

		items.push({
			type: 'group',
			heading: 'Projects',
			items: [{ name: 'All projects', desc: 'Turn off to pick projects.', control: { type: 'toggle', key: 'allProjects' } }],
		});
		if (s.projectIds.length === 0) return items;

		let projectItems: SettingGroupItem[];
		if (this.projects) {
			projectItems = this.projects.map(p => ({ name: p.name, control: { type: 'toggle', key: `project:${p.id}` } }));
		} else if (this.projectsError) {
			projectItems = [{ name: `Couldn't load projects: ${this.projectsError}`, searchable: false }];
		} else {
			// Fetch only once the tab is actually shown, not when Obsidian indexes it for search.
			projectItems = [{ name: 'Loading projects…', searchable: false, render: () => { this.loadProjects(); } }];
		}
		items.push({
			type: 'group',
			items: projectItems,
			search: this.projects ? { placeholder: 'Filter projects', match: (def, q) => def.name.toLowerCase().includes(q.toLowerCase()) } : undefined,
		});
		return items;
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.data.settings;
		if (key === 'folder') return s.folder;
		if (key === 'allProjects') return s.projectIds.length === 0;
		if (key.startsWith('project:')) return s.projectIds.includes(Number(key.slice(8)));
		return undefined;
	}

	async setControlValue(key: string, value: unknown) {
		const s = this.plugin.data.settings;
		if (key === 'folder') {
			s.folder = String(value).trim();
			await this.plugin.save();
			return;
		}
		if (key === 'allProjects') {
			if (value) s.projectIds = [];
			else {
				try { this.projects ??= await this.plugin.client().projects(); }
				catch (e) { new Notice(`Couldn't load projects: ${(e as Error).message}`, 10000); this.update(); return; }
				s.projectIds = this.projects.map(p => p.id);
			}
		} else if (key.startsWith('project:')) {
			const id = Number(key.slice(8));
			s.projectIds = value ? [...s.projectIds, id] : s.projectIds.filter(x => x !== id);
			if (s.projectIds.length === 0) s.projectIds = [id]; // empty would mean "all"
		} else return;
		// Newly picked projects can have messages older than the cursor; look at everything next time.
		this.plugin.data.state.cursor = null;
		await this.plugin.save();
		this.update();
	}

	hide() {
		super.hide();
		this.projectsError = null; // try again next time the tab opens
	}

	private loadProjects() {
		if (this.loadingProjects) return;
		this.loadingProjects = true;
		this.plugin.client().projects()
			.then(p => { this.projects = p; this.projectsError = null; })
			.catch(e => { this.projectsError = (e as Error).message; })
			.finally(() => { this.loadingProjects = false; this.update(); });
	}
}
