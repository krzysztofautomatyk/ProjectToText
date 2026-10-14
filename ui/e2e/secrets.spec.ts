import { expect, test } from '@playwright/test';
import { redactSecrets, redactSecretsWithReport } from '../src/secrets';

// Fixtures mirror the Rust unit tests in src/core/secrets.rs so both implementations agree.
// Secret literals are split with `.join('')` so packing this repo with ptt never mutates its own tests.

test('masks provider tokens and reports RedactionSummary', () => {
  const aws = ['AK', 'IAIOSFODNN7EXAMPLE'].join('');
  const anthropic = ['sk-ant-', 'api03-abcdefghijklmnopqrstuvwx'].join('');
  const openai = ['sk-', 'abcdefghijklmnopqrstuvwx'].join('');
  const google = ['AIza', 'SyDaGmWKa4JsXZ-HjGw7xAAAAAAAAA12345'].join('');
  const stripe = ['sk_live_', '51Habcdefghijklmnopqrstuvwx'].join('');
  const github = ['ghp_', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'].join('');
  const slack = ['xoxb-', '1234567890-abcdefghij'].join('');
  const text = `aws = ${aws}\nanthropic = ${anthropic}\nopenai = ${openai}\ngoogle = ${google}\nstripe = ${stripe}\ngithub = ${github}\nslack = ${slack}\n`;
  const { text: redacted, summary } = redactSecretsWithReport(text);
  for (const kind of [
    'AWS_ACCESS_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_API_KEY',
    'STRIPE_KEY',
    'GITHUB_TOKEN',
    'SLACK_TOKEN',
  ]) {
    expect(redacted).toContain(`[REDACTED: ${kind}]`);
  }
  expect(summary.totalRedactions).toBe(7);
  expect(redacted).not.toContain(['AK', 'IAIOSFODNN7EXAMPLE'].join(''));
  expect(redacted).not.toContain(['ghp_', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'].join(''));
});

test('masks URL basic-auth and generic env secrets while ignoring placeholders', () => {
  const url = ['postgres://admin:', 's3cr3tPass', '@db.internal:5432/app'].join('');
  const envSecret = ['JWT_SECRET=', 'super-secret-jwt-signing-key-999'].join('');
  const envToken = ['API_TOKEN=', '"my_real_token_value"'].join('');
  const placeholder1 = ['EMPTY_SECRET=', '""'].join('');
  const placeholder2 = ['EXAMPLE_API_KEY=', 'your_api_key_here'].join('');
  const placeholder3 = ['NULL_TOKEN=', 'null'].join('');
  const input = `DATABASE_URL=${url}\n${envSecret}\n${envToken}\n${placeholder1}\n${placeholder2}\n${placeholder3}\n`;
  const { text: redacted, summary } = redactSecretsWithReport(input);

  expect(redacted).toContain('postgres://admin:[REDACTED: URL_PASSWORD]@db.internal:5432/app');
  expect(redacted).toContain('JWT_SECRET=[REDACTED: ENV_SECRET]');
  expect(redacted).toContain('API_TOKEN=[REDACTED: ENV_SECRET]');
  expect(redacted).toContain(placeholder1);
  expect(redacted).toContain(placeholder2);
  expect(redacted).toContain(placeholder3);
  expect(summary.totalRedactions).toBe(3);

  // Idempotency check
  const secondPass = redactSecretsWithReport(redacted);
  expect(secondPass.text).toBe(redacted);
  expect(secondPass.summary.totalRedactions).toBe(0);
});

test('masks private key blocks, including truncated ones', () => {
  const beginRsa = ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join('');
  const endRsa = ['-----END RSA ', 'PRIVATE KEY-----'].join('');
  const beginPlain = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const text = `${beginRsa}\nMIIEpAIBAAKCAQEA\n${endRsa}\nafter\n`;
  expect(redactSecrets(text)).toBe('[REDACTED: PRIVATE_KEY]\nafter\n');
  expect(redactSecrets(`${beginPlain}\nMIIEvQIBADANBg\n`)).toBe('[REDACTED: PRIVATE_KEY]');

  // A `"` (e.g. a string terminator) ends the block so source literals survive packing.
  const quoted = `let k = "${beginPlain}\\nMIIEvQIBADANBg\\n";\nlet after = 1;\n`;
  expect(redactSecrets(quoted)).toContain('let after = 1;');
});

test('keeps connection string structure', () => {
  const pwd = ['Password=', 'Sup3r'].join('');
  expect(redactSecrets(`Server=db;Database=app;User Id=sa;${pwd};Encrypt=True`)).toBe(
    'Server=db;Database=app;User Id=sa;Password=[REDACTED: PASSWORD];Encrypt=True',
  );
});

test('masks env-style password assignments', () => {
  const db = ['DB_PASSWORD=', 'Sup3r'].join('');
  const api = ['API_PWD=', 'hunter2'].join('');
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
  const pwd = ['Password=', 'secret'].join('');
  const pwd2 = ['pwd=', 'hunter2'].join('');
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
