import { expect, test } from '@playwright/test';
import { redactSecrets } from '../src/secrets';

// Fixtures mirror the Rust unit tests in src/core/secrets.rs so both implementations agree.
// Secret literals are split with `+` so packing this repo with ptt keeps its own tests readable.

test('masks provider tokens', () => {
  const aws = 'AK' + 'IAIOSFODNN7EXAMPLE';
  const openai = 'sk-' + 'abcdefghijklmnopqrstuvwx';
  const github = 'ghp_' + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const slack = 'xoxb-' + '1234567890-abcdefghij';
  const text = `aws = ${aws}\nopenai = ${openai}\ngithub = ${github}\nslack = ${slack}\n`;
  const redacted = redactSecrets(text);
  for (const kind of ['AWS_ACCESS_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'SLACK_TOKEN']) {
    expect(redacted).toContain(`[REDACTED: ${kind}]`);
  }
  expect(redacted).not.toContain('AK' + 'IAIOSFODNN7EXAMPLE');
  expect(redacted).not.toContain('ghp_' + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});

test('masks private key blocks, including truncated ones', () => {
  const beginRsa = '-----BEGIN RSA ' + 'PRIVATE KEY-----';
  const endRsa = '-----END RSA ' + 'PRIVATE KEY-----';
  const beginPlain = '-----BEGIN ' + 'PRIVATE KEY-----';
  const text = `${beginRsa}\nMIIEpAIBAAKCAQEA\n${endRsa}\nafter\n`;
  expect(redactSecrets(text)).toBe('[REDACTED: PRIVATE_KEY]\nafter\n');
  expect(redactSecrets(`${beginPlain}\nMIIEvQIBADANBg\n`)).toBe('[REDACTED: PRIVATE_KEY]');

  // A `"` (e.g. a string terminator) ends the block so source literals survive packing.
  const quoted = `let k = "${beginPlain}\\nMIIEvQIBADANBg\\n";\nlet after = 1;\n`;
  expect(redactSecrets(quoted)).toContain('let after = 1;');
});

test('keeps connection string structure', () => {
  const pwd = 'Password=' + 'Sup3r';
  expect(redactSecrets(`Server=db;Database=app;User Id=sa;${pwd};Encrypt=True`)).toBe(
    'Server=db;Database=app;User Id=sa;Password=[REDACTED: PASSWORD];Encrypt=True',
  );
});

test('masks env-style password assignments', () => {
  const db = 'DB_PASSWORD=' + 'Sup3r';
  const api = 'API_PWD=' + 'hunter2';
  expect(redactSecrets(`${db}\nexport ${api}\nLOG_LEVEL=debug\n`)).toBe(
    'DB_PASSWORD=[REDACTED: PASSWORD]\nexport API_PWD=[REDACTED: PASSWORD]\nLOG_LEVEL=debug\n',
  );
});

test('leaves double-equals comparisons unchanged', () => {
  for (const text of [
    'password==expected',
    ' password==expected',
    'if (x; password==expected)',
    ' pwd==hash',
    'DB_PASSWORD==debug',
  ]) {
    expect(redactSecrets(text)).toBe(text);
  }
});

test('keeps markdown and call delimiters', () => {
  const pwd = 'Password=' + 'secret';
  const pwd2 = 'pwd=' + 'hunter2';
  expect(redactSecrets(`\`Server=db;${pwd}\``)).toBe(
    '`Server=db;Password=[REDACTED: PASSWORD]`',
  );
  expect(redactSecrets(`x;${pwd2})`)).toBe('x;pwd=[REDACTED: PASSWORD])');
  expect(redactSecrets(`Server=db;${pwd}&Encrypt=True`)).toBe(
    'Server=db;Password=[REDACTED: PASSWORD]&Encrypt=True',
  );
  expect(redactSecrets(`{ ${pwd}}`)).toBe('{ Password=[REDACTED: PASSWORD]}');
});

test('leaves ordinary password code unchanged', () => {
  const text =
    'let password = hash_password(raw);\nuser.password = new_password;\n' +
    'let pwd = env::var("PWD")?;\nconst DB_PASSWORD = getPw();\n';
  expect(redactSecrets(text)).toBe(text);
});

test('leaves ordinary code unchanged', () => {
  const text = 'let task = skip_list;\npassword_hint = "use a manager";\nlet key = sk;\n';
  expect(redactSecrets(text)).toBe(text);
});
