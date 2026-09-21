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
// pick View > Note list style > Apple Notes manually.

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

const log = (...args: any[]) => console.info('[Apple Notes]', ...args);

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

const showManualInstructions = async () => {
	try {
		await joplin.views.dialogs.showMessageBox(
			'Apple Notes is installed.\n\n' +
			'Joplin needs one manual step before it can show the Apple Notes note list: ' +
			'choose View > Note list style > Apple Notes.\n\n' +
			'(Apple Notes tried to do this for you, but this Joplin version would not allow it. ' +
			'You only need to do it once.)',
		);
	} catch (error) {
		log('could not show the instructions dialog', error);
	}
};

// Activates the Apple Notes note list style once, on the first run after install.
// Afterwards it stays out of the way: if the user picks a different note list style
// on purpose, that choice is respected and never overridden.
const ensureNoteListStyleActive = async (dataDir: string) => {
	const state = readState(dataDir);

	if (isOurRenderer(await currentRendererId())) {
		if (state.active !== true) writeState(dataDir, { ...state, active: true });
		return;
	}

	// Already activated once, so the user must have chosen another style on purpose.
	if (state.active === true) return;

	if ((state.attempts || 0) >= MAX_ACTIVATION_ATTEMPTS) return;

	// The user has deliberately selected a renderer other than Joplin's default:
	// leave their choice alone and just point at the menu.
	if ((await currentRendererId()) !== DEFAULT_RENDERER_ID) {
		writeState(dataDir, { ...state, attempts: MAX_ACTIVATION_ATTEMPTS });
		await showManualInstructions();
		return;
	}

	const clicked = await clickNoteListStyleMenuItem();
	if (clicked) {
		const verifyUntil = Date.now() + VERIFY_WAIT_MS;
		while (Date.now() < verifyUntil) {
			if (isOurRenderer(await currentRendererId())) {
				writeState(dataDir, { ...state, active: true });
				log('Apple Notes note list style is active');
				return;
			}
			await sleep(250);
		}
	}

	const attempts = (state.attempts || 0) + 1;
	writeState(dataDir, { ...state, attempts });
	log(`could not activate the note list style automatically (attempt ${attempts})`);
	if (attempts === 1) await showManualInstructions();
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
			await ensureNoteListStyleActive(dataDir);
		} catch (error) {
			log('note list style activation failed', error);
		}
	},
});
