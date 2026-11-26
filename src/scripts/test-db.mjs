#!/usr/bin/env node
// Runs the database tests in supabase/tests/database/*.test.sql.
//
//   DATABASE_URL=postgresql://... npm run test:db            all files
//   DATABASE_URL=postgresql://... npm run test:db -- sales   files whose name contains "sales"
//
// Each test file runs in its own transaction and ends with ROLLBACK, so
// nothing it creates (test pharmacies, logins, sales, even pgTAP itself) is
// left behind. That makes it safe to run against a Supabase branch, a local
// `supabase start` database, or production. A Supabase branch or local
// database is still the better habit.
//
// Use the "Session" or "Direct" connection string from Supabase (Connect >
// Connection string), with the database password. Not the transaction
// pooler (port 6543): the tests need one session for the whole file.
//
// The same files also run with the Supabase CLI: `supabase test db`.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testDir = process.env.DB_TEST_DIR || path.join(root, 'supabase', 'tests', 'database');

// psql's \ir (include, relative to this file) is the only meta-command the
// tests use; inline it so plain node-postgres can run the file.
function expand(file) {
  return readFileSync(file, 'utf8').split('\n').map((line) => {
    const include = line.trim().match(/^\\ir\s+(\S+)/);
    return include ? expand(path.join(path.dirname(file), include[1])) : line;
  }).join('\n');
}

function sslOptions(url) {
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url) || /sslmode=disable/.test(url)) return false;
  if (process.env.DATABASE_CA_CERT) {
    // Supabase > Database settings > SSL configuration > Download certificate.
    return { ca: readFileSync(process.env.DATABASE_CA_CERT, 'utf8'), rejectUnauthorized: true };
  }
  console.warn('! DATABASE_CA_CERT is not set, so the server certificate is not verified.'
    + ' Download it from Supabase (Database settings > SSL) and set DATABASE_CA_CERT=/path/to/prod-ca-2021.crt');
  return { rejectUnauthorized: false };
}

// Every row pgTAP returns is TAP text ("ok 1 - ...", "not ok 2 - ...",
// "# diagnostics", "1..N"). Other statements (setup calls) return nothing useful.
function tapLines(results) {
  const lines = [];
  for (const result of Array.isArray(results) ? results : [results]) {
    for (const row of result?.rows || []) {
      for (const value of Object.values(row)) {
        if (typeof value !== 'string') continue;
        for (const line of value.split('\n')) {
          if (/^(ok|not ok|1\.\.\d+|#)/.test(line)) lines.push(line);
        }
      }
    }
  }
  return lines;
}

async function runFile(client, file) {
  const name = path.basename(file);
  let lines;
  try {
    lines = tapLines(await client.query(expand(file)));
  } catch (error) {
    await client.query('rollback').catch(() => {});
    console.log(`\n✗ ${name}: stopped with an error before finishing`);
    console.log(`  ${error.message}`);
    if (error.where) console.log(`  ${error.where.split('\n')[0]}`);
    return { name, passed: 0, failed: 1, crashed: true };
  }

  const planned = Number((lines.find((line) => /^1\.\.\d+/.test(line)) || '1..0').slice(3));
  const passed = lines.filter((line) => /^ok \d+/.test(line)).length;
  const failed = lines.filter((line) => /^not ok \d+/.test(line)).length;
  const missing = Math.max(0, planned - passed - failed);
  const ok = failed === 0 && missing === 0 && planned > 0;

  console.log(`\n${ok ? '✓' : '✗'} ${name}: ${passed}/${planned} passed`);
  for (const line of lines) {
    if (line.startsWith('not ok') || (!ok && line.startsWith('#'))) console.log(`  ${line}`);
    else if (process.env.VERBOSE) console.log(`  ${line}`);
  }
  if (missing) console.log(`  ${missing} planned test(s) did not run`);
  return { name, passed, failed: failed + missing };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DATABASE_URL to the database to test, e.g.\n'
      + '  DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres" npm run test:db');
    process.exit(2);
  }
  if (/:6543\//.test(url)) {
    console.error('That is the transaction pooler (port 6543). Use the session pooler (5432) or the direct connection.');
    process.exit(2);
  }

  const filters = process.argv.slice(2);
  const files = readdirSync(testDir)
    .filter((name) => name.endsWith('.test.sql'))
    .filter((name) => !filters.length || filters.some((filter) => name.includes(filter)))
    .sort()
    .map((name) => path.join(testDir, name));
  if (!files.length) {
    console.error('No test files matched.');
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl: sslOptions(url) });
  await client.connect();
  const results = [];
  try {
    for (const file of files) results.push(await runFile(client, file));
  } finally {
    await client.end();
  }

  const passed = results.reduce((sum, r) => sum + r.passed, 0);
  const failed = results.reduce((sum, r) => sum + r.failed, 0);
  console.log(`\n${failed ? '✗' : '✓'} ${results.length} file(s), ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});