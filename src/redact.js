// An ALLOWLIST, not a denylist. Fields not named here can never reach Discord,
// including ones somebody adds to the record model next year.
// attachments: files the sender chose to share. They're posted to the channel as they are.
// fileCount: how many there are, shown on the record's message.
const ALLOWED = new Set(['recordId', 'division', 'status', 'itemCount', 'occurredAt', 'attachments', 'fileCount']);

function redact(record) {
  const safe = {};
  for (const key of Object.keys(record)) {
    if (ALLOWED.has(key)) safe[key] = record[key];
  }
  return safe;
}

module.exports = { redact, ALLOWED };
