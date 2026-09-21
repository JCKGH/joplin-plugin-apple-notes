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

function makeMenu(rendererIds, clicks, setting) {
  return {
    items: [{
      id: 'view', submenu: { items: [
        { id: 'someOther', submenu: { items: [{ id: 'nothing' }] } },
        { id: 'noteListStyle', submenu: { items: rendererIds.map(id => ({
          id: `noteListRenderer_${id}`,
          type: 'checkbox',
          // Stands in for Joplin's own handler: Setting.setValue('notes.listRendererId', id)
          click: () => { clicks.push(id); if (id.indexOf(':apple-notes') >= 0) setting.value = id; },
        })) } },
      ] },
    }],
  };
}

// options: { scriptFile, settingValue, rendererIds, menuAppearsAfter, remoteFails, stateOnDisk }
async function runScenario(label, options) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'an-test-'));
  const installDir = path.join(tmp, 'install');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  for (const f of ['theme.css', 'note.css', 'index.js', 'manifest.json']) fs.writeFileSync(path.join(installDir, f), 'x');
  if (options.stateOnDisk) fs.writeFileSync(path.join(dataDir, 'activation.json'), JSON.stringify(options.stateOnDisk));

  const clicks = [];
  const dialogs = [];
  let menuLookups = 0;
  const setting = { value: options.settingValue };

  const fakeRequire = (mod) => {
    if (mod === 'fs') return fs;
    if (mod === '@electron/remote') {
      if (options.remoteFails) throw new Error('remote disabled');
      return { Menu: { getApplicationMenu: () => {
        menuLookups++;
        if (menuLookups <= (options.menuAppearsAfter || 0)) return makeMenu([], clicks, setting);
        return makeMenu(options.rendererIds, clicks, setting);
      } } };
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
    window: { loadChromeCssFile: async () => {}, loadNoteCssFile: async () => {} },
    views: {
      noteList: { registerRenderer: async (renderer) => { registered.renderer = renderer; } },
      dialogs: { showMessageBox: async (msg) => { dialogs.push(msg); return 0; } },
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

  return { label, clicks, dialogs, state, setting, registered, menuLookups };
}

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
    check('A setting ended up on our renderer', r.setting.value === OUR_ID, r.setting.value);
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

  // --- Scenario C: user already picked a different renderer: never override ---
  {
    const r = await runScenario('C', {
      settingValue: 'detailed',
      rendererIds: ['compact', 'detailed', OUR_ID],
    });
    check('C never clicked anything', r.clicks.length === 0, r.clicks);
    check('C told the user once', r.dialogs.length === 1, r.dialogs.length);
    check('C gave up (no retries)', r.state && r.state.attempts >= 3, r.state);
  }

  // --- Scenario D: activated before, user switched to another style: respect it ---
  {
    const r = await runScenario('D', {
      settingValue: 'compact',
      rendererIds: ['compact', OUR_ID],
      stateOnDisk: { active: true },
    });
    check('D never clicked again', r.clicks.length === 0, r.clicks);
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

  // --- Scenario F: remote unavailable (shortened wait) ---
  {
    const patched = path.join(os.tmpdir(), 'an-index-shortwait.js');
    fs.writeFileSync(patched, fs.readFileSync(path.join(BASE, 'dist', 'index.js'), 'utf8')
      .replace('const MENU_WAIT_MS = 20000;', 'const MENU_WAIT_MS = 700;')
      .replace('const VERIFY_WAIT_MS = 3000;', 'const VERIFY_WAIT_MS = 700;'));
    const r = await runScenario('F', {
      scriptFile: patched,
      settingValue: 'compact',
      rendererIds: ['compact', OUR_ID],
      remoteFails: true,
    });
    check('F fell back to the instructions dialog once', r.dialogs.length === 1, r.dialogs.length);
    check('F recorded one attempt', r.state && r.state.attempts === 1, r.state);
    check('F message points at the View menu', typeof r.dialogs[0] === 'string' && r.dialogs[0].includes('View > Note list style > Apple Notes'), r.dialogs[0]);
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
