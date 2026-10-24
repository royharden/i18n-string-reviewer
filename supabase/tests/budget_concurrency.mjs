// SOURCE ONLY during Dirty Mode. No execution has been claimed.
// Later, after both migrations, set BUDGET_TEST_DATABASE_URL to a fresh DISPOSABLE database
// and run: node supabase/tests/budget_concurrency.mjs --disposable
// Requires psql on PATH and database-owner privileges. No external npm dependencies.
// Fixtures intentionally remain in that disposable database; this driver deletes nothing.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

const url = process.env['BUDGET_TEST_DATABASE_URL'];
if (process.argv[2] !== '--disposable' || !url) {
  throw new Error('Requires --disposable and explicit BUDGET_TEST_DATABASE_URL for a fresh isolated database');
}
const COUNT = 20;
const GATE = 3434001;
const user = randomUUID();
const running = new Set();
function connection() {
  // Keep the URL out of command arguments and diagnostic output.
  const child = spawn('psql', ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--tuples-only', '--no-align'], {
    env: { ...process.env, PGDATABASE: url, PGCONNECT_TIMEOUT: '10' }, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  const timeout = setTimeout(() => child.kill(), 90_000);
  timeout.unref();
  running.add(child);
  let output = '';
  // Discard potentially sensitive connection errors; report exit code only.
  child.stderr.on('data', () => undefined);
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stdin.on('error', () => undefined);
  const completed = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Could not launch psql; verify installation and connection manually')));
    child.once('close', (code) => { clearTimeout(timeout); running.delete(child); code === 0 ? resolve(output) : reject(new Error(`psql exited with code ${code}`)); });
  });
  // A handler is attached immediately even while a gated worker waits for release.
  void completed.catch(() => undefined);
  return { child, completed, output: () => output };
}
async function sql(text) {
  const process = connection(); process.child.stdin.end(`${text}\n`); return await process.completed;
}
function jsonRows(text) {
  return text.split(/\r?\n/u).map((row) => row.trim()).filter((row) => row.startsWith('{')).map((row) => JSON.parse(row));
}
function assert(condition, message) { if (!condition) throw new Error(message); }
async function until(probe, message) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) { if (await probe()) return; await pause(30); }
  throw new Error(message);
}
async function gated(reservations) {
  const controller = connection();
  controller.child.stdin.write(`select pg_advisory_lock(${GATE}); select 'GATE_READY';\n`);
  try {
    await until(async () => controller.output().includes('GATE_READY'), 'Timed out acquiring concurrency gate');
    const workers = reservations.map((reservation) => {
      const worker = connection();
      worker.child.stdin.end(`begin; select pg_advisory_xact_lock_shared(${GATE});\n${reservation}\ncommit;\n`);
      return worker.completed;
    });
    // Every independent backend must be blocked at the gate before release. Merely launching
    // Promise.all would not prove that the database sessions had actually overlapped.
    await until(async () => {
      const queued = await sql(`select count(*) from pg_locks where locktype='advisory'
        and database=(select oid from pg_database where datname=current_database())
        and classid=0 and objid=${GATE} and not granted;`);
      return Number(queued.trim()) === reservations.length;
    }, 'Workers did not all reach the database concurrency gate');
    controller.child.stdin.end(`select pg_advisory_unlock(${GATE});\n`);
    await controller.completed;
    return (await Promise.all(workers)).flatMap(jsonRows);
  } finally { if (controller.child.exitCode === null) controller.child.kill(); }
}
function reserve(request, estimate, cap) {
  return `select row_to_json(r)::text from public.reserve_budget('${request}'::uuid,0,'${user}'::uuid,
    'mock','mock-v1',repeat('a',64),array['q0'],${estimate},${cap},'concurrency-v1') r;`;
}

try {
  const startDay = (await sql("select (now() at time zone 'utc')::date;")).trim();
  const existing = await sql("select count(*) from public.daily_budget where day=(now() at time zone 'utc')::date;");
  assert(Number(existing.trim()) === 0, 'Refusing: current UTC day already has budget state; use a fresh disposable database');
  const parallel = await gated(Array.from({ length: COUNT }, () => reserve(randomUUID(), '0.10', '0.30')));
  assert(parallel.length === COUNT, 'Missing parallel reservation results');
  assert(parallel.filter((row) => row.status === 'reserved' && row.created === true).length === 3, 'Near-cap reservations admitted more/less than exactly 0.30 USD');
  assert(parallel.filter((row) => row.status === 'refused_budget' && row.created === true).length === COUNT - 3, 'Refusals not durably recorded');
  const first = jsonRows(await sql(`select json_build_object('committed',committed_usd,'cap',cap_usd) from public.daily_budget
    where day=(now() at time zone 'utc')::date;`))[0];
  assert(first?.committed === 0.3 && first?.cap === 0.3, 'Conditional reserve exceeded daily cap');

  const sameRequest = randomUUID();
  const duplicates = await gated(Array.from({ length: COUNT }, () => reserve(sameRequest, '0.10', '0.40')));
  assert(duplicates.length === COUNT && new Set(duplicates.map((row) => row.ledger_id)).size === 1, 'Same-attempt calls did not share one ledger row');
  assert(duplicates.filter((row) => row.created === true).length === 1, 'Same attempt obtained dispatch ownership more than once');
  assert(duplicates.every((row) => row.status === 'reserved'), 'Unexpected same-attempt state');
  const id = duplicates[0]?.ledger_id;
  assert(typeof id === 'string' && /^[a-f0-9-]{36}$/u.test(id), 'Invalid ledger id from RPC');
  const final = jsonRows(await sql(`select json_build_object('committed',committed_usd,'rows',
      (select count(*) from public.call_ledger where user_id='${user}'::uuid and request_id='${sameRequest}'::uuid))
    from public.daily_budget where day=(now() at time zone 'utc')::date;`))[0];
  assert(final?.committed === 0.4 && final?.rows === 1, 'Duplicate race double-charged or lost a row');

  // Concurrent settlement of one reservation must refund exactly once as well.
  await gated(Array.from({ length: COUNT }, () => `select row_to_json(r)::text from public.reconcile_budget('${id}'::uuid,'ok',0.02,1,1,'{"input_tokens":1,"output_tokens":1}',1) r;`));
  const settled = jsonRows(await sql(`select json_build_object('committed',committed_usd) from public.daily_budget where day=(now() at time zone 'utc')::date;`))[0];
  assert(settled?.committed === 0.32, 'Concurrent settlement refunded more than once');
  assert((await sql("select (now() at time zone 'utc')::date;")).trim() === startDay, 'Run crossed UTC midnight; repeat on a fresh database away from midnight');
  console.log('PASS: 20 independent gated sessions: near-cap reserve, same-attempt ownership, reconcile once. Disposable fixtures retained.');
} finally {
  for (const process of running) process.kill();
}
