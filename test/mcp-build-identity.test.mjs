import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
test('build identity rejects dirty code and conflicting environment SHA', () => {
  const root = mkdtempSync(join(tmpdir(), 'metropolis-build-'));
  try {
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'src'));
    copyFileSync(new URL('../scripts/write-mcp-source-identity.mjs', import.meta.url), join(root, 'scripts/write-mcp-source-identity.mjs'));
    writeFileSync(join(root, 'src/mcp-source-identity.mjs'), "export const SOURCE_SHA = 'UNKNOWN';\n");
    writeFileSync(join(root, 'src/code.mjs'), 'export const version = 1;\n');
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
    const sha = git('rev-parse', 'HEAD');
    const childEnv = { ...process.env }; delete childEnv.GITHUB_SHA; delete childEnv.CF_PAGES_COMMIT_SHA;
    const run = extra => spawnSync(process.execPath, ['scripts/write-mcp-source-identity.mjs'], { cwd: root, env: { ...childEnv, ...extra }, encoding: 'utf8' });
    assert.equal(run({}).status, 0);
    assert.ok(readFileSync(join(root, 'src/mcp-source-identity.mjs'), 'utf8').includes(sha));
    assert.equal(run({}).status, 0); // generated identity is the only permitted dirty file
    assert.notEqual(run({ GITHUB_SHA: 'b'.repeat(40) }).status, 0);
    writeFileSync(join(root, 'src/code.mjs'), 'export const version = 2;\n');
    assert.notEqual(run({}).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
