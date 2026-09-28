// Runs a cargo subcommand for the Tauri shell. Rust is optional for web-only contributors: when
// cargo is missing the step reports that it was skipped (loudly) instead of failing the monorepo
// pipeline. CI for desktop sets ORBIT_REQUIRE_RUST=1 to make a missing toolchain an error.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const sub = process.argv[2] ?? 'test';
const candidates = ['cargo', path.join(homedir(), '.cargo', 'bin', 'cargo')];
const cargo = candidates.find((c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0 || (c.includes(path.sep) && existsSync(c)));

if (!cargo) {
  const msg = `[desktop] SKIPPED cargo ${sub}: Rust toolchain not installed (https://rustup.rs).`;
  if (process.env.ORBIT_REQUIRE_RUST === '1') {
    console.error(msg);
    process.exit(1);
  }
  console.warn(msg);
  process.exit(0);
}

const args = sub === 'check' ? ['check', '--all-targets'] : [sub];
const res = spawnSync(cargo, [...args, '--manifest-path', 'src-tauri/Cargo.toml'], { stdio: 'inherit' });
process.exit(res.status ?? 1);
