// A small JSON file store for the orders app: read once, change in memory, write the whole file.
//
// Writes go one at a time and replace the file in a single rename, so a crash mid-write leaves
// the previous version rather than half a file. Fine for a practice app with one server process;
// the real backend keeps this in Postgres.
const fs = require('fs');
const path = require('path');

function createJsonStore(file, initial) {
  let data = null;
  let line = Promise.resolve();

  function load() {
    if (data) return data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`${path.basename(file)} could not be read: ${err.message}`);
      data = structuredClone(initial);
    }
    return data;
  }

  function write(text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text);
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      // Windows refuses the rename while another program (an antivirus scan, an open editor)
      // holds the file. Writing in place is the fallback.
      if (err.code !== 'EPERM' && err.code !== 'EBUSY') throw err;
      fs.writeFileSync(file, text);
      fs.rmSync(tmp, { force: true });
    }
  }

  // Saves what is in memory now. Resolves once it is on disk.
  function save() {
    const text = JSON.stringify(load(), null, 2);
    line = line.then(() => write(text)).catch((err) => {
      console.error(`[store] could not write ${path.basename(file)}: ${err.message}`);
    });
    return line;
  }

  return {
    get data() { return load(); },
    save,
  };
}

module.exports = { createJsonStore };
