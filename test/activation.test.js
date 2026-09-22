// Verification harness for the Apple Notes plugin's first-run note list activation.
// Loads the real built dist/index.js in a VM with a mocked Joplin plugin host and a
// mocked @electron/remote, and checks the activation state machine end to end.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const BASE = '/Users/Shared/hermes-share/notes-theme/apple-notes-list';
const OUR_ID = 'com.jk.applenoteslist:apple-notes';

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '   ' + (extra === undefined ? '' : JSON.stringify(extra))));
  if (!cond) failures++;
}

// A stand-in for the Joplin application menu. `click` imitates Joplin's own
// handler for a note list style item: Setting.setValue('notes.listRendererId', id).
function makeMenu(rendererIds, clicks, setting, opts) {
  const noop = !!(opts && opts.clickIsNoop);
  return {
    items: [{
      id: 'view', submenu: { items: [
        { id: 'someOther', submenu: { items: [{ id: 'nothing' }] } },
        { id: 'noteListStyle', submenu: { items: rendererIds.map(id => ({
          id: `noteListRenderer_${id}`,
          type: 'checkbox',
          click: () => { clicks.push(id); if (!noop && id.indexOf(':apple-notes') >= 0) setting.value = id; },
        })) } },
      ] },
    }],
  };
}

// options: { scriptFile, settingValue, rendererIds, menuAppearsAfter, remoteFails,
//            stateOnDisk, pluginClickIsNoop, mainWindowFails }
async function runScenario(label, options) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'an-test-'));
  const installDir = path.join(tmp, 'install');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  for (const f of ['theme.css', 'note.css', 'index.js', 'manifest.json']) fs.writeFileSync(path.join(installDir, f), 'x');
  if (options.stateOnDisk) fs.writeFileSync(path.join(dataDir, 'activation.json'), JSON.stringify(options.stateOnDisk));

  const clicks = [];          // clicks seen by the PLUGIN window's copy of the menu
  const mainClicks = [];      // clicks seen by the MAIN window's copy of the menu
  const dialogs = [];
  const toasts = [];
  let menuLookups = 0;
  const setting = { value: options.settingValue };

  // What the injected fallback code sees once it is running inside the main window.
  const mainMenu = makeMenu(options.rendererIds, mainClicks, setting, {});
  const mainSandbox = {};
  vm.createContext(mainSandbox);
  const mainRequire = (mod) => {
    if (mod === '@electron/remote') return { Menu: { getApplicationMenu: () => mainMenu } };
    throw new Error('unexpected require in main window: ' + mod);
  };
  mainSandbox.window = { require: mainRequire };
  mainSandbox.require = mainRequire;

  const fakeRequire = (mod) => {
    if (mod === 'fs') return fs;
    if (mod === '@electron/remote') {
      if (options.remoteFails) throw new Error('remote disabled');
      return {
        Menu: { getApplicationMenu: () => {
          menuLookups++;
          if (menuLookups <= (options.menuAppearsAfter || 0)) return makeMenu([], clicks, setting, {});
          return makeMenu(options.rendererIds, clicks, setting, { clickIsNoop: options.pluginClickIsNoop });
        } },
        getGlobal: (name) => {
          if (options.mainWindowFails) return null;
          if (name !== 'joplinBridge') throw new Error('unexpected global ' + name);
          return { mainWindow: () => ({ webContents: {
            executeJavaScript: async (code) => vm.runInContext(code, mainSandbox),
          } }) };
        },
      };
    }
    throw new Error('unexpected require: ' + mod);
  };

  const registered = {};
  const joplin = {
    plugins: {
      register: (plugin) => { registered.plugin = plugin; },
      installationDir: async () => installDir,
      dataDir: async () => dataDir,
    },
    commands: { register: async (cmd) => { registered.command = cmd; } },
    window: { loadChromeCssFile: async () => {}, loadNoteCssFile: async () => {} },
    views: {
      noteList: { registerRenderer: async (renderer) => { registered.renderer = renderer; } },
      menuItems: { create: async (name, commandName, location) => { registered.menuItem = { name, commandName, location }; } },
      dialogs: {
        showMessageBox: async (msg) => { dialogs.push(msg); return 0; },
        showToast: async (t) => { toasts.push(t); },
      },
    },
    settings: {
      globalValue: async (key) => {
        if (key !== 'notes.listRendererId') throw new Error('unexpected setting ' + key);
        return setting.value;
      },
    },
  };

  const sandbox = {
    joplin,
    require: fakeRequire,
    setTimeout, clearTimeout, console, Promise, JSON, Date, Math,
    __clicked: clicks,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const scriptFile = options.scriptFile || path.join(BASE, 'dist', 'index.js');
  vm.runInContext(fs.readFileSync(scriptFile, 'utf8'), sandbox, { filename: scriptFile });

  await registered.plugin.onStart();

  const state = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'activation.json'), 'utf8')); } catch (e) { return null; }
  })();
  const diagLog = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'activation-log.json'), 'utf8')); } catch (e) { return null; }
  })();

  return { label, clicks, mainClicks, dialogs, toasts, state, diagLog, setting, registered, menuLookups, dataDir };
}

// The shorter waits used by the failure scenarios, so the suite stays fast.
const SHORT = path.join(os.tmpdir(), 'an-index-shortwait.js');
fs.writeFileSync(SHORT, fs.readFileSync(path.join(BASE, 'dist', 'index.js'), 'utf8')
  .replace('const MENU_WAIT_MS = 20000;', 'const MENU_WAIT_MS = 700;')
  .replace('const VERIFY_WAIT_MS = 3000;', 'const VERIFY_WAIT_MS = 700;'));

(async () => {
  // --- Scenario A: fresh install, default renderer, menu item there immediately ---
  {
    const r = await runScenario('A', {
      settingValue: 'compact',
      rendererIds: ['compact', 'detailed', OUR_ID],
    });
    check('A renderer registered with the plugin id', r.registered.renderer && r.registered.renderer.id === 'apple-notes', r.registered.renderer && r.registered.renderer.id);
    check('A clicked our menu item exactly once', r.clicks.length === 1 && r.clicks[0] === OUR_ID, r.clicks);
    check('A state marked active', r.state && r.state.active === true, r.state);
    check('A no dialog', r.dialogs.length === 0, r.dialogs.length);
    check('A announced it with a toast', r.toasts.length === 1, r.toasts.length);
    check('A setting ended up on our renderer', r.setting.value === OUR_ID, r.setting.value);
    check('A wrote a diagnostic log', !!r.diagLog && Array.isArray(r.diagLog.events) && r.diagLog.events.length > 0, !!r.diagLog);
    check('A registered the re-apply command in Tools', r.registered.command && r.registered.command.name === 'appleNotesReapplyNoteListStyle' && r.registered.menuItem && r.registered.menuItem.location === 'tools', r.registered.menuItem);
  }

  // --- Scenario B: fresh install, the menu item only appears after a few polls ---
  {
    const r = await runScenario('B', {
      settingValue: 'compact',
      rendererIds: ['compact', OUR_ID],
      menuAppearsAfter: 3,
    });
    check('B polled the menu until the item appeared', r.menuLookups >= 4, r.menuLookups);
    check('B clicked our item', r.clicks.length === 1, r.clicks);
  }

  // --- Scenario C: first run switches the style even when another one is selected ---
  {
    const r = await runScenario('C', {
      settingValue: 'detailed',
      rendererIds: ['compact', 'detailed', OUR_ID],
    });
    check('C switched anyway (first run always switches)', r.clicks.length === 1 && r.setting.value === OUR_ID, { c: r.clicks, s: r.setting.value });
    check('C no dialog and marked active', r.dialogs.length === 0 && r.state && r.state.active === true, { d: r.dialogs, s: r.state });
  }

  // --- Scenario D: activated before, user switched to another style: respect it ---
  {
    const r = await runScenario('D', {
      settingValue: 'compact',
      rendererIds: ['compact', OUR_ID],
      stateOnDisk: { active: true },
    });
    check('D never clicked again', r.clicks.length === 0 && r.mainClicks.length === 0, { c: r.clicks, m: r.mainClicks });
    check('D no dialog', r.dialogs.length === 0, r.dialogs.length);
  }

  // --- Scenario E: already ours: nothing to do ---
  {
    const r = await runScenario('E', {
      settingValue: OUR_ID,
      rendererIds: ['compact', OUR_ID],
      stateOnDisk: { active: true },
    });
    check('E no click, no dialog', r.clicks.length === 0 && r.dialogs.length === 0, { c: r.clicks, d: r.dialogs });
    check('E state stays active', r.state && r.state.active === true, r.state);
  }

  // --- Scenario G: the plugin window's click is a no-op (cross-renderer callback
  //     lost), so it falls back to clicking from the main window ---
  {
    const r = await runScenario('G', {
      scriptFile: SHORT,
      settingValue: 'compact',
      rendererIds: ['compact', OUR_ID],
      pluginClickIsNoop: true,
    });
    check('G tried the plugin window first', r.clicks.length === 1, r.clicks);
    check('G then clicked from the main window', r.mainClicks.length === 1 && r.mainClicks[0] === OUR_ID, r.mainClicks);
    check('G setting ended up on our renderer', r.setting.value === OUR_ID, r.setting.value);
    check('G state marked active, no dialog', r.state && r.state.active === true && r.dialogs.length === 0, { s: r.state, d: r.dialogs });
  }

  // --- Scenario H: remote unavailable everywhere (shortened wait) ---
  {
    const r = await runScenario('H', {
      scriptFile: SHORT,
      settingValue: 'compact',
      rendererIds: ['compact', OUR_ID],
      remoteFails: true,
    });
    check('H fell back to the instructions dialog once', r.dialogs.length === 1, r.dialogs.length);
    check('H recorded one attempt', r.state && r.state.attempts === 1, r.state);
    check('H message points at the View menu', typeof r.dialogs[0] === 'string' && r.dialogs[0].includes('View > Note list style > Apple Notes'), r.dialogs[0]);
  }

  // --- Scenario I: no main window at all and the click never lands ---
  {
    const r = await runScenario('I', {
      scriptFile: SHORT,
      settingValue: 'compact',
      rendererIds: ['compact', OUR_ID],
      pluginClickIsNoop: true,
      mainWindowFails: true,
    });
    check('I told the user what to do', r.dialogs.length === 1, r.dialogs.length);
    check('I did not mark itself active', !(r.state && r.state.active === true), r.state);
  }

  // --- Scenario J: the re-apply command switches the style on demand ---
  {
    const r = await runScenario('J', {
      settingValue: 'compact',
      rendererIds: ['compact', OUR_ID],
    });
    r.setting.value = 'compact';          // the user switched back by hand
    await r.registered.command.execute();
    check('J command switched the style', r.setting.value === OUR_ID, r.setting.value);
    check('J command said so', r.toasts.length >= 2, r.toasts.length);
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
