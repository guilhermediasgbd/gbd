/**
 * migrate.js — Import a CRM backup JSON into crm-data.json
 *
 * Usage:
 *   node migrate.js path/to/crm-backup-2026-05-18.json
 *
 * Run BEFORE starting server.js for the first time.
 * Safe to re-run — merges data (does not delete existing keys).
 */

const fs   = require('fs');
const path = require('path');

const backupPath = process.argv[2];
if (!backupPath) {
  console.error('\nUsage: node migrate.js path/to/crm-backup-YYYY-MM-DD.json\n');
  process.exit(1);
}

const resolvedBackup = path.resolve(backupPath);
if (!fs.existsSync(resolvedBackup)) {
  console.error('\nFile not found:', resolvedBackup, '\n');
  process.exit(1);
}

let backup;
try {
  backup = JSON.parse(fs.readFileSync(resolvedBackup, 'utf8'));
} catch(e) {
  console.error('\nFailed to parse backup file:', e.message, '\n');
  process.exit(1);
}

if (!backup.data || backup.version !== 1) {
  console.error('\nInvalid backup file (must be exported from this CRM).\n');
  process.exit(1);
}

const dataFile = path.join(__dirname, 'crm-data.json');

// Merge: load existing data (if any) then overwrite with backup
let existing = {};
if (fs.existsSync(dataFile)) {
  try { existing = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch(e) {}
}

let count = 0;
for (const [key, val] of Object.entries(backup.data)) {
  if (val !== null && val !== undefined) {
    existing[key] = val;
    count++;
  }
}

const tmp = dataFile + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
fs.renameSync(tmp, dataFile);

console.log('\n✓ Migration complete!');
console.log(`  Imported : ${count} data categories`);
console.log(`  Data file: ${dataFile}`);
console.log(`  Backup   : ${resolvedBackup}`);
console.log(`  Exported : ${new Date(backup.exportedAt).toLocaleString()}`);
console.log('\nNext step: node server.js\n');
