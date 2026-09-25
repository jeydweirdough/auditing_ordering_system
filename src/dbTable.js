// A "table" of named JSON rows, kept in app_config: the settings lists, the
// roles and their permissions, the promotions, the product catalogue.
//
// Same calls as the Discord-thread tables it replaces (getRow, saveRow,
// getAllRowValues…), so configStore and products didn't change shape. Reads
// come from a copy in memory, because the order form asks for these on every
// render; loadRows() refreshes that copy, and src/server.js calls it at most
// every CONFIG_TTL_MS so an edit made through another server instance shows up
// here within that time.
const db = require('./db');

function createDbTable({ tableName }) {
  const rows = new Map();   // rowId -> data
  let loadedAt = 0;

  async function loadRows() {
    const found = await db.prepare('SELECT row_id, data FROM app_config WHERE table_name = ?').all(tableName);
    rows.clear();
    for (const r of found) rows.set(r.row_id, typeof r.data === 'string' ? JSON.parse(r.data) : r.data);
    loadedAt = Date.now();
    return getAllRows();
  }

  async function saveRow(rowId, data) {
    rows.set(rowId, data);
    await db.prepare(
      `INSERT INTO app_config (table_name, row_id, data, updated_at) VALUES (?, ?, ?::jsonb, ?)
       ON CONFLICT (table_name, row_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
    ).run(tableName, rowId, JSON.stringify(data), new Date().toISOString());
  }

  async function deleteRow(rowId) {
    rows.delete(rowId);
    await db.prepare('DELETE FROM app_config WHERE table_name = ? AND row_id = ?').run(tableName, rowId);
    return { ok: true };
  }

  const getRow = (rowId) => rows.get(rowId) ?? null;
  const getAllRows = () => Object.fromEntries(rows);
  const getAllRowValues = () => [...rows.values()];

  return {
    loadRows,
    getRow,
    saveRow,
    deleteRow,
    getAllRows,
    getAllRowValues,
    // In memory only, until saveRow: used while filling in defaults at load.
    setRowData: (rowId, data) => rows.set(rowId, data),
    loadedAt: () => loadedAt,
    describe: () => ({ tableName, rowsCount: rows.size, mode: 'database' }),
  };
}

module.exports = { createDbTable };
