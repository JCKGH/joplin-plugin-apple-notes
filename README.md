# Apple Notes for Joplin

Makes Joplin look and feel like Apple Notes on macOS.

## What it does

- **Apple Notes note list** — note rows show a bold title with the date and a snippet on a second line, inset hairline separators, Apple-style spacing, and the warm yellow selection highlight.
- **Apple-style editor chrome** — large bold title, date/time aligned to the title, a frosted-glass toolbar, and a uniform toolbar band, in both light and dark mode.
- **Light and dark mode** — follows your macOS appearance automatically, with Apple's cool light palette and true dark charcoal palette.
- **No functionality removed** — every Joplin control (sync, search, sort, tags, markdown toggle, note toolbar) is restyled and kept in place. Nothing is deleted or hidden behind settings.
- **Self-contained** — all styles are packaged inside the plugin. No userchrome.css or userstyle.css editing, no external files to install.

## Installation

1. Open Joplin and go to **Tools → Options → Plugins** (on macOS: **Joplin → Settings → Plugins**).
2. Search for **Apple Notes** and click **Install** — or, if you downloaded `plugin.jpl` from
   GitHub, install it from the plugin page's gear menu (**Install from file**).
3. Restart Joplin when it offers to. Joplin only starts plugins while it is starting up, so this
   is when **Apple Notes** takes effect — and when it switches the note list style for you.

## How the note list style gets enabled

Joplin keeps the selected note list style in a built-in setting, and its plugin API deliberately
does not allow plugins to change built-in settings — there is no "activate this renderer" call
either. So on its first run the plugin does the only thing that is equivalent to a user action:
it invokes Joplin's own **View → Note list style → Apple Notes** menu item (through the
`@electron/remote` access that Joplin enables for plugin windows) and then verifies that the
setting actually changed. The result is the same as if you had clicked it yourself.

This happens the first time the plugin runs, whatever note list style was selected
before — installing the theme puts Joplin on the Apple Notes note list. Pick another
style afterwards if you prefer; that choice is yours and is kept.

If that is not possible on your Joplin version, the plugin tells you once, and you can set it
manually from **View → Note list style → Apple Notes**.

Once the style has been active, the plugin never touches your choice again: if you deliberately
switch to another note list style, that is respected.

**Tools → "Apple Notes: Switch the note list style"** runs the same switch whenever you ask for
it — handy after you have tried one of Joplin's other note list styles.

## Troubleshooting

The plugin records what it did at startup in `plugin-data/com.jk.applenoteslist/activation-log.json`
inside the [Joplin profile directory](https://joplinapp.org/help/apps/faq/#where-does-joplin-store-its-settings)
— include that file when reporting a problem and it will say exactly where it stopped.

## Usage notes

- The theme follows your macOS **System Settings → Appearance** for light/dark mode.
- Inside a specific notebook the note title uses the full width; in All Notes / Search / Tag views the title truncates to make room for the location chip.
- The sync status expander is hidden by design; the sync checkmark still appears as the sync indicator.

## Compatibility

- Requires Joplin 3.0 or later (desktop).
- Designed for the desktop app on macOS; light and dark mode are both supported.

## Feedback

Issues and suggestions are welcome via the [repository issue tracker](https://github.com/JCKGH/joplin-plugin-apple-notes/issues).

## Development

```bash
npm install
npm run build   # tsc + bundle CSS into publish/plugin.jpl + publish/manifest.json
```

`publish/` is what gets published to npm, and what the Joplin plugin repository picks up:
it looks for npm packages carrying the `joplin-plugin` keyword that contain a `publish/`
directory with a `manifest.json` and a `.jpl`.

To try a build without publishing, install `publish/plugin.jpl` directly from Joplin's
**Options → Plugins → (gear) → Install from file**.

Layout:

- `src/index.ts` — plugin entry point: loads the CSS, registers the note list renderer, activates the note list style on first run.
- `src/theme.css` — app chrome styles.
- `src/note.css` — note viewer (rendered Markdown) styles.
- `src/manifest.json` — the Joplin plugin manifest (id, version, description, ...).
- `test/activation.test.js` — runs the built plugin against a mocked Joplin host and a mocked `@electron/remote`, and checks the first-run activation logic (`node test/activation.test.js`).

## License

MIT — see [LICENSE](LICENSE).
