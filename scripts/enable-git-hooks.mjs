// npm "prepare" step: turn on the gitleaks git hooks in a developer checkout.
// Silently skipped where there is no git (for example on a build server).
import { execSync } from 'node:child_process';

try {
  execSync('git config core.hooksPath .githooks', { stdio: 'ignore' });
} catch {
  // not a git checkout: nothing to do
}
