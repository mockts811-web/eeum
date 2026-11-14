// 고현 수정 시작: 대시보드에 붙여넣을 단일 파일과 검토용 패키지 생성. 배포/push는 하지 않습니다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = process.argv[2] && path.resolve(process.argv[2]);
if (!destination || destination === root || destination.startsWith(root + path.sep)) throw new Error('저장소 밖의 명시적 출력 경로가 필요합니다.');
if (execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim() !== 'feature/dugong') throw new Error('feature/dugong에서만 생성하세요.');
const relativeImports = /^import(?: type)?\s+[^\n]+\s+from\s+["']\.[^\n]+["'];\s*$/gm;
const flatten = source => source.replace(relativeImports, '').replace(/^export /gm, '');
const shared = flatten(fs.readFileSync(path.join(root, 'supabase/functions/_shared/photo-analysis.ts'), 'utf8'));
const handler = flatten(fs.readFileSync(path.join(root, 'supabase/functions/auto-analyze-items/handler.ts'), 'utf8'));
const entry = flatten(fs.readFileSync(path.join(root, 'supabase/functions/auto-analyze-items/index.ts'), 'utf8'));
fs.mkdirSync(path.join(destination, 'editor'), { recursive: true });
function write(name, value) { fs.writeFileSync(path.join(destination, name), value); }
write('editor/auto-analyze-items.ts', '// 고현 수정 시작: 생성된 단일 파일. npm SDK import는 Supabase 런타임에서 해석합니다.\n' + shared + '\n' + handler + '\n' + entry + '\n// 고현 수정 끝: 생성된 단일 파일\n');
const files = ['supabase/functions/_shared/photo-analysis.ts',
  'supabase/functions/auto-analyze-items/handler.ts', 'supabase/functions/auto-analyze-items/index.ts',
  'tests/photo-ai.test.cjs', 'scripts/build-photo-ai.mjs'];
for (const entry of fs.readdirSync(path.join(root, 'supabase/photo-ai'), { withFileTypes: true })) {
  if (entry.isFile()) files.push('supabase/photo-ai/' + entry.name);
}
for (const relative of files) {
  const target = path.join(destination, 'source', relative); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, relative), target);
}
for (const name of ['APPLY.ko.md', 'SECOND_REVIEW.ko.md']) {
  const source = path.join(root, 'supabase/photo-ai', name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(destination, name));
}
let patch = '';
for (const relative of files) {
  const result = spawnSync('git', ['diff', '--no-index', '--', '/dev/null', relative], { cwd: root, encoding: 'utf8' });
  if (result.status !== 1) throw new Error('패치 생성 실패: ' + relative);
  patch += result.stdout;
}
write('feature-dugong-photo-ai.patch', patch);
const hashes = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const p = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name !== 'SHA256SUMS.txt') hashes.push(createHash('sha256').update(fs.readFileSync(p)).digest('hex') + '  ' + path.relative(destination, p));
  }
}
walk(destination);
write('SHA256SUMS.txt', '# 고현 수정 시작: 생성물 무결성\n' + hashes.sort().join('\n') + '\n# 고현 수정 끝\n');
console.log(JSON.stringify({ destination, files: hashes.length, baseline: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), deployed: false }));
// 고현 수정 끝: 단일 파일과 검토용 패키지 생성
