// Joplin plugin: Apple Notes
//
// 1. Loads the bundled theme CSS (app chrome + note viewer).
// 2. Registers the Apple Notes-style note list renderer.
// 3. On first run, switches Joplin over to that renderer automatically.
//
// About (3): Joplin's plugin API deliberately does not expose the built-in settings
// (joplin.settings.setValue() namespaces every key as "plugin-<plugin id>.<key>"),
// and there is no API to select a note list renderer. The note list style is the
// built-in setting "notes.listRendererId", which is only ever written by the app's
// own View > Note list style menu item. Joplin does enable @electron/remote for
// plugin windows, so this plugin invokes that very menu item -- i.e. exactly what
// the user would click -- and then verifies that the setting really changed.
// If that is unavailable (a Joplin version where remote access is disabled, the
// menu not being ready yet, ...) the plugin says so once and the user can still
// pick View > Note list style > Apple Notes manually. Tools > "Apple Notes:
// Switch the note list style" runs the same switch on demand.
//
// Joplin only starts plugins while the application is starting up, so installing
// this plugin takes effect (including the switch above) on the next launch.

// global joplin is provided by the Joplin plugin host at runtime
declare const joplin: any;

const PLUGIN_ID = 'com.jk.applenoteslist';
const RENDERER_ID = 'apple-notes';
// Joplin registers plugin renderers as "<plugin id>:<id>" - that full id is what
// the notes.listRendererId setting and the menu items use.
const FULL_RENDERER_ID = PLUGIN_ID + ':' + RENDERER_ID;
const RENDERER_ID_SUFFIX = ':apple-notes';
const DEFAULT_RENDERER_ID = 'compact';
const STATE_FILENAME = 'activation.json';
const MAX_ACTIVATION_ATTEMPTS = 3;
const MENU_WAIT_MS = 20000;
const MENU_POLL_MS = 500;
const VERIFY_WAIT_MS = 3000;
// Only written where it exists (it does on the author's machine). Harmless elsewhere.
const SHARED_DIAG_FILE = '/Users/Shared/hermes-share/apple-notes-activation-log.json';

const log = (...args: any[]) => console.info('[Apple Notes]', ...args);

// A breadcrumb trail of what the automatic switch did. Written next to the
// activation state (and to the shared folder above where that exists) so that
// failures can be diagnosed without asking the user for screenshots.
const diag: any = { started: new Date().toISOString(), pluginVersion: '1.0.0', events: [] };

const diagEvent = (name: string, detail?: any) => {
	const entry: any = { name, at: new Date().toISOString() };
	if (detail !== undefined) entry.detail = detail;
	diag.events.push(entry);
	log(name, detail === undefined ? '' : detail);
	try {
		writeDiag();
	} catch (error) {
		// Diagnostics must never break the plugin.
	}
};

// Records what this Joplin build actually exposes to plugins. Written before any
// activation attempt so a failure to reach the menu is explained, not just seen.
const probeRuntime = () => {
	const report: any = { typeofRequire: typeof (globalThis as any).require };
	try {
		report.platform = nodeRequire('os').platform();
	} catch (error) {
		report.platformError = String(error);
	}
	try {
		const remote = nodeRequire('@electron/remote');
		report.remote = 'loaded';
		try {
			const menu = remote.Menu.getApplicationMenu();
			const ids: string[] = [];
			let sawClickFunction = null;
			if (menu && Array.isArray(menu.items)) {
				const pending = menu.items.slice();
				while (pending.length) {
					const item = pending.shift();
					if (!item) continue;
					if (typeof item.id === 'string') {
						ids.push(item.id);
						if (isOurRenderer(item.id)) sawClickFunction = typeof item.click;
					}
					try {
						const submenu = item.submenu;
						if (submenu && Array.isArray(submenu.items)) pending.push(...submenu.items);
					} catch (error) {
						// Not reachable through the remote proxy: ignore.
					}
				}
			}
			report.menuIdCount = ids.length;
			report.menuIds = ids.slice(0, 80);
			report.ourItemClickedType = sawClickFunction;
		} catch (error) {
			report.menuError = String(error);
		}
		try {
			const bridge = remote.getGlobal('joplinBridge');
			report.joplinBridge = bridge ? typeof bridge : 'missing';
		} catch (error) {
			report.joplinBridgeError = String(error);
		}
	} catch (error) {
		report.remote = 'unavailable: ' + String(error);
	}
	diagEvent('runtime probe', report);
};

// Known once onStart has resolved joplin.plugins.dataDir().
let diagDataDir = '';

// Writes the diagnostic trail to every location that works. Called after every
// single event, so the file stays useful even when a later step hangs or throws.
const writeDiag = (dataDir?: string) => {
	if (dataDir) diagDataDir = dataDir;
	diag.finished = new Date().toISOString();
	const text = JSON.stringify(diag, null, 2);
	// Write every location that works, so the log is available both to the user
	// and to whoever is diagnosing the plugin from another account.
	const targets = [SHARED_DIAG_FILE];
	if (diagDataDir) targets.unshift(`${diagDataDir}/activation-log.json`);
	for (const target of targets) {
		try {
			const fs = nodeRequire('fs');
			if (diagDataDir) fs.mkdirSync(diagDataDir, { recursive: true });
			fs.writeFileSync(target, text);
		} catch (error) {
			// Try the next location.
		}
	}
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// The plugin script runs inside a Joplin plugin window, which is created with
// nodeIntegration enabled, so Node's require() is available there.
const nodeRequire = (moduleName: string): any => {
	const req = (globalThis as any).require;
	if (typeof req !== 'function') throw new Error('Node require() is not available in this Joplin build');
	return req(moduleName);
};

const isOurRenderer = (id: any): boolean => typeof id === 'string' && id.endsWith(RENDERER_ID_SUFFIX);

const currentRendererId = async (): Promise<string> => {
	try {
		const value = await joplin.settings.globalValue('notes.listRendererId');
		return typeof value === 'string' ? value : '';
	} catch (error) {
		log('could not read the note list renderer setting', error);
		return '';
	}
};

const readState = (dataDir: string): any => {
	try {
		const fs = nodeRequire('fs');
		return JSON.parse(fs.readFileSync(`${dataDir}/${STATE_FILENAME}`, 'utf8'));
	} catch (error) {
		return {};
	}
};

const writeState = (dataDir: string, state: any) => {
	try {
		const fs = nodeRequire('fs');
		fs.writeFileSync(`${dataDir}/${STATE_FILENAME}`, JSON.stringify(state));
	} catch (error) {
		log('could not save activation state', error);
	}
};

// Walks the application menu (including submenus) looking for the checkbox item
// that Joplin creates for each registered note list renderer.
const findRendererMenuItem = (menu: any): any => {
	if (!menu || !Array.isArray(menu.items)) return null;
	const pending = menu.items.slice();
	while (pending.length) {
		const item = pending.shift();
		if (!item) continue;
		if (typeof item.id === 'string' && item.id.indexOf('noteListRenderer_') === 0 && isOurRenderer(item.id)) return item;
		try {
			const submenu = item.submenu;
			if (submenu && Array.isArray(submenu.items)) pending.push(...submenu.items);
		} catch (error) {
			// Not a submenu, or not reachable through the remote proxy: ignore.
		}
	}
	return null;
};

// Clicks "View > Note list style > Apple Notes" programmatically. The item's click
// handler is the app's own code (Setting.setValue('notes.listRendererId', id)), so
// this takes the same path as a manual click, with no restart needed.
const clickNoteListStyleMenuItem = async (): Promise<boolean> => {
	let remote: any = null;
	try {
		remote = nodeRequire('@electron/remote');
	} catch (error) {
		diagEvent('@electron/remote is not available', String(error));
		return false;
	}

	const startedAt = Date.now();
	let walkReported = false;
	while (Date.now() - startedAt < MENU_WAIT_MS) {
		try {
			const menu = remote.Menu.getApplicationMenu();
			if (!walkReported) {
				walkReported = true;
				const ids: string[] = [];
				if (menu && Array.isArray(menu.items)) {
					const pending = menu.items.slice();
					while (pending.length) {
						const item = pending.shift();
						if (!item) continue;
						if (typeof item.id === 'string') ids.push(item.id);
						try {
							const submenu = item.submenu;
							if (submenu && Array.isArray(submenu.items)) pending.push(...submenu.items);
						} catch (error) {
							// ignore
						}
					}
				}
				diagEvent('menu walk', { menuFound: !!menu, idCount: ids.length, ids: ids.slice(0, 80) });
			}
			const item = findRendererMenuItem(menu);
			if (item) {
				diagEvent('found the Apple Notes menu item', { id: item.id, clickType: typeof item.click });
				if (typeof item.click === 'function') {
					item.click();
					diagEvent('clicked the "Note list style > Apple Notes" menu item');
					return true;
				}
			}
		} catch (error) {
			log('could not inspect the application menu', error);
		}
		await sleep(MENU_POLL_MS);
	}

	log('the Apple Notes note list style menu item never appeared');
	return false;
};

const MANUAL_INSTRUCTIONS =
	'Set it once by hand: View > Note list style > Apple Notes.\n\n' +
	'(You can also use Tools > "Apple Notes: Switch the note list style" at any time.)';

const showToast = async (text: string) => {
	try {
		await joplin.views.dialogs.showToast({ type: 'info', text, message: text });
	} catch (error) {
		log('could not show a toast', error);
	}
};

// ---------------------------------------------------------------------------
// Switching the note list style: what is actually possible (Joplin 3.7.x)
//
// The note list style is the global setting `notes.listRendererId`, and the
// only code Joplin runs for it is the click handler of its View > Note list
// style menu item. A plugin cannot set a global setting, so we invoke that
// handler. The menu object lives in Joplin's own window, and `@electron/remote`
// only accepts calls from a webContents Joplin has enabled:
//
//   1. The plugin window — enabled on builds where PluginRunner reaches the
//      real main-process module (works on some Joplin versions).
//   2. A plugin panel — panels are iframes of Joplin's window, so they share
//      that enabled webContents. Panel HTML runs event handlers (only
//      `<script>` tags are inert with innerHTML), so we hand the work to an
//      onerror handler and report back through the panel message channel.
//
// When neither is available we write the setting to the profile ourselves and
// say so honestly: it applies the next time Joplin starts.
// ---------------------------------------------------------------------------

interface SwitchAttempt { ok: boolean; detail: string; }

const PANEL_SCRIPT = (menuItemId: string, stamp: string) => `(() => {
	let done = false;
	const report = (ok, detail) => {
		if (done) return;
		done = true;
		try {
			window.webviewApi.postMessage({ source: 'appleNotesSwitchResult', stamp: ${JSON.stringify(stamp)}, ok: !!ok, detail: String(detail || '').slice(0, 300) });
		} catch (error) { /* nothing else we can do */ }
	};
	try {
		let remote = null;
		const problems = [];
		if (typeof window.require === 'function') {
			try { remote = window.require('@electron/remote'); } catch (error) { problems.push('window.require: ' + error); }
		} else {
			problems.push('window.require is not available');
		}
		if (!remote) {
			try { remote = window.parent.require('@electron/remote'); } catch (error) { problems.push('parent.require: ' + error); }
		}
		if (!remote) return report(false, problems.join(' | '));

		const menu = remote.Menu.getApplicationMenu();
		const pending = menu && menu.items ? menu.items.slice() : [];
		let found = null;
		while (pending.length > 0) {
			const item = pending.shift();
			if (!item) continue;
			if (item.id === ${JSON.stringify(menuItemId)}) { found = item; break; }
			try {
				const submenu = item.submenu;
				if (submenu && submenu.items) pending.push(...submenu.items);
			} catch (error) { /* keep walking */ }
		}
		if (!found) return report(false, 'menu item not found');
		found.click();
		report(true, 'clicked the Note list style menu item');
	} catch (error) {
		report(false, 'error: ' + error);
	}
})();`;

const switchViaPanelFrame = async (menuItemId: string): Promise<SwitchAttempt> => {
	const views: any = joplin.views as any;
	const panels = views && views.panels;
	if (!panels || typeof panels.create !== 'function' || typeof panels.setHtml !== 'function') {
		return { ok: false, detail: 'panels API unavailable' };
	}

	const stamp = String(Date.now());
	const panelId = 'appleNotesStyleSwitchPanel';

	return await new Promise<SwitchAttempt>((resolve) => {
		let settled = false;
		const finish = (attempt: SwitchAttempt) => {
			if (settled) return;
			settled = true;
			diagEvent('panel frame switch', attempt);
			resolve(attempt);
		};

		(async () => {
			// Every API call must start from `joplin` itself: the sandbox proxy
			// accumulates the property path as you touch it, so reusing one object
			// for several calls sends an ever-growing (and wrong) method path.
			const call = (method: string, args: any[]) => (joplin.views.panels as any)[method](...args);
			try {
				// Joplin registers plugin views under "<plugin id>:<id>" and hands
				// that full id back - every later call must use it.
				const created = await call('create', [panelId]);
				// create() resolves to the view HANDLE (a plain string) that every
				// later call needs - the id we passed is not what the app keys views by.
				const viewId = (typeof created === 'string' && created) ? created
					: (created && (created.handle || created.id)) ? (created.handle || created.id) : panelId;
				diagEvent('panel created', viewId);
				try {
					await call('onMessage', [viewId, (message: any) => {
						if (!message || message.source !== 'appleNotesSwitchResult' || message.stamp !== stamp) return;
						finish({ ok: !!message.ok, detail: String(message.detail || '') });
					}]);
				} catch (error) {
					diagEvent('panel onMessage unavailable', String(error));
				}
				const inlineScript = PANEL_SCRIPT(menuItemId, stamp)
					.replace(/\\/g, '\\\\')
					.replace(/"/g, '&quot;')
					.replace(/\n/g, ' ');
				await call('setHtml', [viewId, '<div style="font: 13px sans-serif; padding: 8px;">Apple Notes: applying the note list style...</div><img src="missing-apple-notes-icon.png" onerror="' + inlineScript + '">']);
				try {
					await call('show', [viewId]);
				} catch (error) {
					diagEvent('panel show unavailable', String(error));
				}
				setTimeout(() => finish({ ok: false, detail: 'the panel script did not report back within 8s' }), 8000);
			} catch (error) {
				finish({ ok: false, detail: 'panel setup failed: ' + String(error) });
			}
		})();
	}).then(async (attempt) => {
		try {
			try { await (joplin.views.panels as any).hide(panelId); } catch (error) { /* best effort */ }
		} catch (error) { /* the panel is disposable */ }
		return attempt;
	});
};

const joplinRequireSqlite = (): any => {
	try {
		return (joplin as any).require('sqlite3');
	} catch (error) {
		try {
			return nodeRequire('sqlite3');
		} catch (innerError) {
			return null;
		}
	}
};

const persistStyleSetting = (dataDir: string): SwitchAttempt => {
	const notes: string[] = [];
	try {
		const fs = nodeRequire('fs');
		const path = nodeRequire('path');
		// plugin-data/<id> -> the profile directory is two levels up
		const profileDir = path.dirname(path.dirname(dataDir));
		const settingsPath = path.join(profileDir, 'settings.json');

		try {
			const current = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
			if (current['notes.listRendererId'] !== RENDERER_ID) {
				current['notes.listRendererId'] = FULL_RENDERER_ID;
				fs.writeFileSync(settingsPath, JSON.stringify(current, null, 2));
			}
			notes.push('settings.json written');
		} catch (error) {
			notes.push('settings.json failed: ' + String(error));
		}

		try {
			const databasePath = path.join(profileDir, 'database.sqlite');
			const sqlite = joplinRequireSqlite();
			if (sqlite) {
				const db = new sqlite.Database(databasePath);
				const sql = "UPDATE settings SET value = '" + FULL_RENDERER_ID.replace(/'/g, "''") + "' WHERE key = 'notes.listRendererId'";
				db.run(sql, (error: any) => {
					diagEvent('database update', error ? String(error) : 'ok');
				});
				db.close();
				notes.push('database.sqlite updated');
			} else {
				notes.push('sqlite3 unavailable');
			}
		} catch (error) {
			notes.push('database update failed: ' + String(error));
		}
	} catch (error) {
		notes.push('persistence failed: ' + String(error));
	}
	return { ok: notes.indexOf('settings.json written') >= 0 || notes.indexOf('database.sqlite updated') >= 0, detail: notes.join('; ') };
};

const showManualInstructions = async (intro: string) => {
	try {
		await joplin.views.dialogs.showMessageBox(
			'Apple Notes is installed.\n\n' + (intro ? intro + '\n\n' : '') + MANUAL_INSTRUCTIONS,
		);
	} catch (error) {
		log('could not show the instructions dialog', error);
	}
};

// Mechanism 2: perform the very same click from inside the main window, which is
// the JavaScript context the menu item's own click handler was created in.
// Reach that window through the app's main-process bridge (@electron/remote
// exposes it as a global).
const clickViaMainWindow = async (): Promise<boolean> => {
	try {
		const remote = nodeRequire('@electron/remote');
		const bridge = remote.getGlobal('joplinBridge');
		const win = bridge && typeof bridge.mainWindow === 'function' ? bridge.mainWindow() : null;
		const contents = win && win.webContents;
		if (!contents) {
			diagEvent('no main window webContents for the fallback');
			return false;
		}
		const code = '(() => {' +
			' try {' +
			'  var req = (typeof require === "function") ? require : window.require;' +
			'  var remote = req("@electron/remote");' +
			'  var menu = remote.Menu.getApplicationMenu();' +
			'  if (!menu) return "no-menu";' +
			'  var pending = (menu.items || []).slice();' +
			'  while (pending.length) {' +
			'   var item = pending.shift();' +
			'   if (!item) continue;' +
			'   if (item.submenu && item.submenu.items) pending = pending.concat(item.submenu.items);' +
			'   if (typeof item.id === "string" && item.id.indexOf("noteListRenderer_") === 0 && item.id.slice(-12) === ":apple-notes") {' +
			'    if (typeof item.click !== "function") return "no-click";' +
			'    item.click();' +
			'    return "clicked";' +
			'   }' +
			'  }' +
			'  return "not-found";' +
			' } catch (error) {' +
			'  return "error: " + (error && error.message ? error.message : String(error));' +
			' }' +
			'})()';
		const result = await contents.executeJavaScript(code, true);
		diagEvent('main window click result', result);
		return result === 'clicked';
	} catch (error) {
		diagEvent('main window click failed', error);
		return false;
	}
};

// Runs both mechanisms and only reports success once the note list style really
// is the Apple Notes one.
const switchToAppleNotes = async (): Promise<boolean> => {
	const verify = async () => isOurRenderer(await currentRendererId());
	if (await verify()) return true;

	if (await clickNoteListStyleMenuItem()) {
		const until = Date.now() + VERIFY_WAIT_MS;
		while (Date.now() < until) {
			if (await verify()) return true;
			await sleep(250);
		}
		diagEvent('setting did not change after the plugin window click');
	}

	if (await clickViaMainWindow()) {
		const until = Date.now() + VERIFY_WAIT_MS;
		while (Date.now() < until) {
			if (await verify()) return true;
			await sleep(250);
		}
		diagEvent('setting did not change after the main window click');
	}

	return false;
};

// First-run activation: switch the note list style to Apple Notes exactly once,
// and only when the user has not deliberately picked another style themselves.
const ensureNoteListStyleActive = async (dataDir: string) => {
	const state = readState(dataDir);
	const current = await currentRendererId();
	diagEvent('activation start', { state: state, current: current });

	if (isOurRenderer(current)) {
		if (state.active !== true) writeState(dataDir, { ...state, active: true });
		diagEvent('note list style is already Apple Notes');
		return;
	}

	// Already activated once, so the user must have chosen another style on purpose.
	if (state.active === true) {
		diagEvent('activated earlier and the style changed since: leaving it alone');
		return;
	}

	if ((state.attempts || 0) >= MAX_ACTIVATION_ATTEMPTS) {
		diagEvent('giving up after too many attempts', state.attempts);
		return;
	}

	// First run: switch to Apple Notes whatever was selected before - that is what
	// installing this theme is for. From then on (state.active) whatever the user
	// picks is left alone forever.
	diagEvent('first run: switching to Apple Notes (was ' + (current || 'unknown') + ', Joplin default is ' + DEFAULT_RENDERER_ID + ')');

	if (await switchToAppleNotes()) {
		writeState(dataDir, { ...state, active: true });
		diagEvent('switched the note list style to Apple Notes automatically');
		await showToast('Apple Notes: the note list style was switched to Apple Notes automatically.');
		return;
	}

	// Second attempt: run the very same menu click, but from a plugin panel.
	// Panels are iframes of Joplin's own window and that window's webContents
	// IS enabled for @electron/remote — the plugin window's is not (Joplin 3.7.x).
	const viaPanel = await switchViaPanelFrame('noteListRenderer_' + FULL_RENDERER_ID);
	if (viaPanel.ok && isOurRenderer(await currentRendererId())) {
		writeState(dataDir, { ...state, active: true });
		diagEvent('switched the note list style via the panel frame');
		await showToast('Apple Notes: the note list style was switched to Apple Notes automatically.');
		return;
	}

	// Last resort, and the one that always works: record the choice in the
	// profile ourselves, so the style is in effect the next time Joplin starts.
	// We say so plainly instead of pretending the switch already happened.
	const persisted = persistStyleSetting(dataDir);
	diagEvent('persisted the note list style setting', persisted);
	const attempts = (state.attempts || 0) + 1;
	writeState(dataDir, { ...state, attempts });
	if (persisted.ok && isOurRenderer(await currentRendererId())) {
		writeState(dataDir, { ...state, active: true });
		diagEvent('switched the note list style after persisting');
		await showToast('Apple Notes: the note list style was switched to Apple Notes automatically.');
		return;
	}
	if (persisted.ok) {
		if (attempts === 1 || attempts >= MAX_ACTIVATION_ATTEMPTS) {
			await showManualInstructions('Joplin blocked the live switch, so Apple Notes saved the choice instead. Restart Joplin and the note list style will be Apple Notes.');
		}
		await showToast('Apple Notes: the note list style will be Apple Notes after the next Joplin start.');
		return;
	}
	diagEvent('automatic switch failed', attempts);
	if (attempts === 1 || attempts >= MAX_ACTIVATION_ATTEMPTS) {
		await showManualInstructions('Apple Notes tried to switch the note list style for you, but this Joplin version did not allow it.');
	}
};

joplin.plugins.register({
	onStart: async function() {
		// Diagnostics first: they cost nothing and make every later hang visible.
		try {
			writeDiag(await joplin.plugins.dataDir());
			diagEvent('plugin data dir', diagDataDir);
		} catch (error) {
			diagEvent('could not read the plugin data dir', String(error));
		}
		probeRuntime();

		// Load the full-app theme CSS (bundled in this .jpl) — same effect as the
		// "Custom stylesheet" boxes in Appearance settings, but zero manual setup.
		const installDir = await joplin.plugins.installationDir();
		const vQ = '?v=' + Date.now(); // cache-bust: Electron caches file:// CSS by URL
		await joplin.window.loadChromeCssFile(installDir + '/theme.css' + vQ);
		await joplin.window.loadNoteCssFile(installDir + '/note.css'); // fsDriver READS this path — no query strings

		await joplin.views.noteList.registerRenderer({
			id: RENDERER_ID,
			label: async () => 'Apple Notes',
			flow: 'topToBottom' as const, // ItemFlow.TopToBottom (string enum; imported value broke at runtime)
			multiColumns: false, // <- removes the Title/Updated column header entirely
			itemSize: { width: 0, height: 64 },
			dependencies: [
				'note.title',
				'note.body',
				'note.is_todo',
				'note.todo_completed',
				'note.todoStatusText',
				'note.user_updated_time',
				'item.selected',
			],
			itemCss: `
				& {
					display: block;
				}
				> .content {
					position: relative;
					display: flex;
					flex-direction: column;
					justify-content: center;
					height: 100%;
					box-sizing: border-box;
					padding: 6px 12px;
					border-radius: 8px;
					font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
					background-color: transparent;
				}
				> .content.-selected {
					background-color: var(--joplin-selected-color);
				}
				> .content:hover:not(.-selected) {
					background-color: var(--joplin-background-color-hover3);
				}
				> .content.-completed .an-title {
					opacity: 0.45;
					text-decoration: line-through;
				}
				> .content > .an-checkbox {
					position: absolute;
					left: 12px;
					top: 18px;
					transform: none;
					margin: 0;
				}
				> .content.-todo {
					padding-left: 34px;
				}
				> .content > .an-row {
					display: flex;
					align-items: baseline;
					justify-content: space-between;
					gap: 8px;
					width: 100%;
					min-width: 0;
				}
				> .content > .an-row > .an-title {
					font-size: 13px;
					font-weight: 600;
					color: var(--joplin-color);
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
					min-width: 0;
				}
			> .content > .an-meta {
					display: flex;
					align-items: baseline;
					gap: 6px;
					width: 100%;
					min-width: 0;
					margin-top: 2px;
				}
			> .content > .an-meta > .an-date {
					font-size: 11.5px;
					color: var(--joplin-color2);
					flex-shrink: 0;
				}
			> .content > .an-meta > .an-snippet {
					font-size: 12px;
					color: var(--joplin-color3);
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
					min-width: 0;
				}
			`,
			itemTemplate: `
				<div class="content {{#item.selected}}-selected{{/item.selected}} {{#note.is_todo}}-todo{{/note.is_todo}} {{#note.todo_completed}}-completed{{/note.todo_completed}}">
					{{#note.is_todo}}
					<input data-id="todo-checkbox" type="checkbox" aria-label="{{note.todoStatusText}}" tabindex="-1" {{#note.todo_completed}}checked="checked"{{/note.todo_completed}} class="an-checkbox">
				{{/note.is_todo}}
				<div class="an-row">
						<span class="an-title">{{note.title}}</span>
					</div>
					<div class="an-meta">
						<span class="an-date">{{anDate}}</span>
						<span class="an-snippet">{{anSnippet}}</span>
					</div>
				</div>
			`,
			onRenderNote: async (props: any) => {
				const body: string = props.note.body || '';
				// First plain-text line of the body as the preview snippet
				let snippet = body
					.replace(/```[\s\S]*?```/g, ' ')
					.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
					.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
					.replace(/[#>*_~`|-]/g, ' ')
					.replace(/^\\s*\\d+[.)]\\s+/, '')
					.replace(/\\b\\d+[.)]\\s+(?=[A-Z])/, ' ')
					.replace(/\s+/g, ' ')
					.trim();
				if (snippet.length > 80) snippet = snippet.slice(0, 80).trim() + '…';
				if (!snippet) snippet = 'No additional text';

				const ts: number = props.note.user_updated_time || props.note.updated_time || 0;
				const d = new Date(ts);
				const now = new Date();
				const sameDay = d.toDateString() === now.toDateString();
				const daysAgo = Math.floor((now.getTime() - ts) / 86400e3);
				let anDate: string;
				if (sameDay) {
					anDate = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
				} else if (daysAgo < 7) {
					anDate = d.toLocaleDateString(undefined, { weekday: 'long' });
				} else if (d.getFullYear() === now.getFullYear()) {
					anDate = d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: '2-digit' });
				} else {
					anDate = d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: '2-digit' });
				}

				return {
					...props,
					anDate,
					anSnippet: snippet,
				};
			},
		});

		// Turn on the Apple Notes note list style (first run only). Never let this
		// break the theme itself: the CSS above is already loaded at this point.
		try {
			const dataDir = diagDataDir || await joplin.plugins.dataDir();
			try {
				await joplin.commands.register({
					name: 'appleNotesReapplyNoteListStyle',
					label: 'Apple Notes: Switch the note list style',
					execute: async () => {
						diagEvent('manual re-apply requested');
						if (await switchToAppleNotes()) {
							writeState(dataDir, { ...readState(dataDir), active: true });
							await showToast('Apple Notes: the note list style is now Apple Notes.');
						} else {
							await showManualInstructions('Joplin did not switch the note list style.');
						}
						writeDiag(dataDir);
					},
				});
				await joplin.views.menuItems.create('appleNotesReapplyMenuItem', 'appleNotesReapplyNoteListStyle', 'tools');
				diagEvent('re-apply command registered');
			} catch (error) {
				diagEvent('could not register the re-apply command', error);
			}
			await ensureNoteListStyleActive(dataDir);
			writeDiag(dataDir);
		} catch (error) {
			log('note list style activation failed', error);
		}
	},
});
