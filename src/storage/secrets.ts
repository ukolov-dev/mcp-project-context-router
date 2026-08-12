export type SecretHit = {
  path: string;
  line: number;
  reason: string;
};

const patterns: Array<[RegExp, string]> = [
  [/-----BEGIN (?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/, 'private key'],
  [new RegExp('-----BEGIN PGP PRIVATE KEY B' + 'LOCK-----'), 'PGP private key'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i, 'authorization bearer token'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/, 'JWT'],
  [/\b(sk|pk|rk|api)[-_]?(live|test)?[-_][A-Za-z0-9]{24,}\b/i, 'API key-like token'],
  [/\b(password|passwd|pwd|secret|token)\b\s*[:=]\s*["']?[^"'\s]{8,}/i, 'secret-like assignment'],
];

const privateKeyLabel = '(?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED) )?PRIVATE KEY|PGP PRIVATE KEY BLOCK';
const privateKeyBegin = new RegExp(`-----BEGIN (?:${privateKeyLabel})-----`);
const privateKeyEnd = new RegExp(`-----END (?:${privateKeyLabel})-----`);

export function scanSecrets(path: string, text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [pattern, reason] of patterns) {
      if (pattern.test(line) && !/placeholder|example|dummy|changeme|set-in|<.+>/i.test(line)) {
        hits.push({ path, line: index + 1, reason });
      }
    }
  });
  return hits;
}

export function redactSecrets(text: string): string {
  const output: string[] = [];
  let privateKeyBlock = false;
  for (const line of text.split(/\r?\n/)) {
    if (privateKeyBlock) {
      if (privateKeyEnd.test(line)) privateKeyBlock = false;
      continue;
    }
    if (privateKeyBegin.test(line)) {
      output.push('[REDACTED: private key]');
      privateKeyBlock = true;
      continue;
    }
    const reason = secretReason(line);
    output.push(reason ? `[REDACTED: ${reason}]` : line);
  }
  return output.join('\n');
}

function secretReason(line: string): string | undefined {
  for (const [pattern, reason] of patterns) {
    if (pattern.test(line) && !isPlaceholder(line)) return reason;
  }
  return undefined;
}

function isPlaceholder(line: string): boolean {
  return /placeholder|example|dummy|changeme|change-me|set-in|<.+>/i.test(line);
}
