import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['playwright', 'test'],
  {
    stdio: 'inherit',
    env: { ...process.env, METONA_E2E_COVERAGE: '1' },
  },
);
process.exit(result.status ?? 1);
