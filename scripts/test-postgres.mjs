/* global URL, console, process */

import { spawnSync } from 'node:child_process';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://clinics_test:clinics_test@localhost:55432/clinics_test?schema=public';
const databaseName = new URL(databaseUrl).pathname.slice(1).split('?')[0] ?? '';

if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
  console.error(
    `Refusing PostgreSQL tests: database "${databaseName}" is not a dedicated test database.`,
  );
  process.exit(1);
}

const environment = { ...process.env, DATABASE_URL: databaseUrl };
const executableSuffix = process.platform === 'win32' ? '.cmd' : '';

function run(args) {
  const [executable, ...executableArgs] = args;
  const executablePath =
    process.platform === 'win32'
      ? `.\\node_modules\\.bin\\${executable}${executableSuffix}`
      : `./node_modules/.bin/${executable}`;
  const result = spawnSync(executablePath, executableArgs, {
    env: environment,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(['prisma', 'migrate', 'deploy']);
run(['vitest', 'run', 'tests/integration/postgres.test.ts']);
