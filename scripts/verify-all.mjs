import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobileDir = resolve(rootDir, 'apps/mobile');

function runStep(title, command, args, cwd = rootDir) {
  process.stdout.write(`\n==> ${title}\n`);
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
  });
}

function hasCommand(command) {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

runStep('TypeScript workspace build', 'pnpm', ['build']);
runStep('TypeScript workspace typecheck', 'pnpm', ['typecheck']);
runStep('TypeScript & Bridge E2E test suites', 'pnpm', ['test']);

if (hasCommand('flutter')) {
  runStep('Flutter mobile static analysis', 'flutter', ['analyze'], mobileDir);
  runStep('Flutter mobile widget & WebSocket E2E tests', 'flutter', ['test'], mobileDir);
}

process.stdout.write('\n[OK] All Nienie verification checks passed.\n');
