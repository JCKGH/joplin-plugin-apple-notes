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

const RENDERER_ID = 'apple-notes';
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
};

const writeDiag = (dataDir: string) => {
	diag.finished = new Date().toISOString();
	const text = JSON.stringify(diag, null, 2);
	for (const target of [`${dataDir}/activation-log.json`, SHARED_DIAG_FILE]) {
		try {
			nodeRequire('fs').writeFileSync(target, text);
			return;
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
		log('@electron/remote is not available', error);
		return false;
	}

	const startedAt = Date.now();
	while (Date.now() - startedAt < MENU_WAIT_MS) {
		try {
			const menu = remote.Menu.getApplicationMenu();
			const item = findRendererMenuItem(menu);
			if (item && typeof item.click === 'function') {
				item.click();
				log('clicked the "Note list style > Apple Notes" menu item');
				return true;
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

	// The user has deliberately selected a renderer other than Joplin's default:
	// leave their choice alone and just point at the menu.
	if (current !== DEFAULT_RENDERER_ID) {
		writeState(dataDir, { ...state, attempts: MAX_ACTIVATION_ATTEMPTS });
		diagEvent('leaving the user-chosen note list style alone', current);
		await showManualInstructions(current
			? 'Your note list style is "' + current + '", so it was left exactly as it is.'
			: 'The current note list style could not be read, so nothing was changed.');
		return;
	}

	if (await switchToAppleNotes()) {
		writeState(dataDir, { ...state, active: true });
		diagEvent('switched the note list style to Apple Notes automatically');
		await showToast('Apple Notes: the note list style was switched to Apple Notes automatically.');
		return;
	}

	const attempts = (state.attempts || 0) + 1;
	writeState(dataDir, { ...state, attempts });
	diagEvent('automatic switch failed', attempts);
	if (attempts === 1 || attempts >= MAX_ACTIVATION_ATTEMPTS) {
		await showManualInstructions('Apple Notes tried to switch the note list style for you, but this Joplin version did not allow it.');
	}
};

joplin.plugins.register({
	onStart: async function() {
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
			const dataDir = await joplin.plugins.dataDir();
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
