import { App, htmlToMarkdown, normalizePath, Notice, Plugin, PluginSettingTab, requestUrl, Setting, TFile } from 'obsidian';
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

	constructor(app: App, private plugin: BulletinPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		const s = this.plugin.data.settings;
		containerEl.empty();

		const account = new Setting(containerEl).setName('Basecamp account');
		if (this.plugin.isConnected()) {
			account.setDesc(`Connected to ${s.accountName}. Read-only access.`)
				.addButton(b => b.setButtonText('Disconnect').onClick(async () => {
					await this.plugin.disconnect();
					this.projects = null;
					this.display();
				}));
		} else {
			account.setDesc('Opens Basecamp in your browser to approve read-only access to one account.')
				.addButton(b => b.setButtonText('Connect').setCta().onClick(async () => {
					b.setDisabled(true).setButtonText('Waiting for browser…');
					try { await this.plugin.connect(); }
					catch (e) { new Notice(`Couldn't connect: ${(e as Error).message}`, 10000); }
					this.display();
				}));
		}

		new Setting(containerEl)
			.setName('Folder')
			.setDesc('Messages go in <folder>/<project>/Messages/.')
			.addText(t => t.setPlaceholder('Basecamp').setValue(s.folder).onChange(async v => {
				s.folder = v.trim();
				await this.plugin.save();
			}));

		if (!this.plugin.isConnected()) return;

		new Setting(containerEl).setName('Projects').setHeading();
		new Setting(containerEl)
			.setName('All projects')
			.setDesc('Turn off to pick projects.')
			.addToggle(t => t.setValue(s.projectIds.length === 0).onChange(async all => {
				if (!all) {
					this.projects ??= await this.plugin.client().projects();
					s.projectIds = this.projects.map(p => p.id);
				} else {
					s.projectIds = [];
				}
				await this.projectsChanged();
			}));

		if (s.projectIds.length === 0) return;
		const list = containerEl.createDiv();
		const render = (projects: Project[]) => {
			for (const p of projects) {
				new Setting(list).setName(p.name).addToggle(t => t.setValue(s.projectIds.includes(p.id)).onChange(async on => {
					s.projectIds = on ? [...s.projectIds, p.id] : s.projectIds.filter(id => id !== p.id);
					if (s.projectIds.length === 0) s.projectIds = [p.id]; // empty would mean "all"
					await this.projectsChanged();
				}));
			}
		};
		if (this.projects) render(this.projects);
		else {
			list.setText('Loading projects…');
			this.plugin.client().projects().then(p => { this.projects = p; list.empty(); render(p); })
				.catch(e => list.setText(`Couldn't load projects: ${(e as Error).message}`));
		}
	}

	private async projectsChanged() {
		// Newly picked projects can have messages older than the cursor; look at everything next time.
		this.plugin.data.state.cursor = null;
		await this.plugin.save();
		this.display();
	}
}
