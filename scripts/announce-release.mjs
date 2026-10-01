import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { announceRelease, broadcastExitCode, ReleaseBroadcastError } from '../server/release-broadcast.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function main(argv = process.argv.slice(2), env = process.env) {
  let db;
  try {
    const { values } = parseArgs({ args: argv, options: {
      send: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
      manifest: { type: 'string' }, database: { type: 'string' }, receipts: { type: 'string' },
      'release-sha': { type: 'string' },
    } });
    if (values.send && values['dry-run']) throw new ReleaseBroadcastError('conflicting_modes');
    const databasePath = path.resolve(values.database || env.PAGENT_DB_PATH || path.join(root, 'data', 'pagent.sqlite'));
    const receiptsPath = path.resolve(values.receipts || path.join(path.dirname(databasePath), 'release-broadcast.sqlite'));
    const manifest = JSON.parse(fs.readFileSync(values.manifest || path.join(root, 'release-notes', 'latest.json'), 'utf8'));
    // Do not call openDatabase/createApp: they run migrations and start services.
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    const report = await announceRelease({ db, receiptsPath, manifest, env, send: values.send, releaseSha: values['release-sha'] || null });
    console.log(JSON.stringify(report));
    return broadcastExitCode(report);
  } catch (error) {
    // Never print arbitrary fetch/DB exceptions, URLs, tokens or recipient IDs.
    console.error(JSON.stringify({ status: 'error', code: error instanceof ReleaseBroadcastError ? error.code : 'broadcast_failed' }));
    return 1;
  } finally { db?.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
