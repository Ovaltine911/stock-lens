import { execFileSync } from 'node:child_process';

// Inspect the exact staging area, not ignored local credentials.
const files = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = /(^|\/)(\.local|\.env(?:\..*)?|node_modules|\.picode|private|artifacts)(\/|$)|mcp_config\.json$|\.(?:pem|key)$/;
const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['api-token', /\bsk-[A-Za-z0-9_-]{24,}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['jwt-like-credential', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_.-]{60,}/],
  ['machine-path', /\/(?:Users|private\/var)\/[A-Za-z0-9_/.-]{8,}/],
];
const issues = [];
let bytes = 0;
for (const file of files) {
  if (forbidden.test(file)) { issues.push({ file, issue: 'forbidden-file' }); continue; }
  const buffer = execFileSync('git', ['show', `:${file}`], { maxBuffer: 5_000_000 });
  bytes += buffer.length;
  if (buffer.length > 1_000_000) issues.push({ file, issue: 'oversized-file' });
  const content = buffer.toString('utf8');
  for (const [name, pattern] of patterns) if (pattern.test(content)) issues.push({ file, issue: name });
}
console.log(JSON.stringify({ stagedFiles: files.length, totalBytes: bytes, issues }, null, 2));
console.log(issues.length ? 'SUBMISSION_SCAN=FAIL' : 'SUBMISSION_SCAN=PASS');
console.log('扫描只列文件和问题类型，不回显疑似凭证；模式检查不替代人工复核。');
if (issues.length || !files.length) process.exitCode = 1;
