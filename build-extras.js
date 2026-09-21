// Builds the two files the Joplin plugin repository expects inside the npm package:
//   publish/plugin.jpl     - the plugin itself: gzipped TAR (Joplin's tarExtract)
//   publish/manifest.json  - the same manifest that is inside the .jpl, used for the
//                            plugin listing at https://joplinapp.org/plugins
// Run through `npm run build`.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const pack = require('tar-stream').pack();

const dist = path.join(__dirname, 'dist');
const src = path.join(__dirname, 'src');
const publish = path.join(__dirname, 'publish');

const files = [
  { name: 'index.js', from: path.join(dist, 'index.js') },
  { name: 'manifest.json', from: path.join(dist, 'manifest.json') },
  { name: 'theme.css', from: path.join(src, 'theme.css') },
  { name: 'note.css', from: path.join(src, 'note.css') },
];

fs.mkdirSync(publish, { recursive: true });

const jpl = path.join(publish, 'plugin.jpl');
const gzip = zlib.createGzip();
const out = fs.createWriteStream(jpl);
pack.pipe(gzip).pipe(out);

// Fixed timestamp so that rebuilding the same source produces a byte-identical .jpl
// (and therefore a meaningful SHA-256 for the released artifact).
const mtime = new Date(0);

const done = new Promise((res, rej) => {
  out.on('finish', () => { console.log('Built ' + jpl); res(); });
  out.on('error', rej);
});

(async () => {
  for (const f of files) {
    if (!fs.existsSync(f.from)) throw new Error(f.from + ' missing');
    await new Promise((res, rej) => {
      pack.entry({ name: f.name, mtime }, fs.readFileSync(f.from), err => err ? rej(err) : res());
    });
  }
  pack.finalize();
  await done;
  fs.copyFileSync(path.join(dist, 'manifest.json'), path.join(publish, 'manifest.json'));
  console.log('Built ' + path.join(publish, 'manifest.json'));
})().catch(e => { console.error(e.message); process.exit(1); });
