import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sha = process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA || head;
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('EXACT_SOURCE_SHA_REQUIRED');
if (sha !== head) throw new Error('BUILD_SOURCE_SHA_MISMATCH');
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).split('\n').filter(Boolean);
if (dirty.some(line => line.slice(3) !== 'src/mcp-source-identity.mjs')) throw new Error('CLEAN_DEPLOY_TREE_REQUIRED');
writeFileSync(new URL('../src/mcp-source-identity.mjs', import.meta.url), `// Generated from the exact build commit.\nexport const SOURCE_SHA = '${sha}';\n`);
