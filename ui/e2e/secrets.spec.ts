import { expect, test } from '@playwright/test';
import { redactSecrets, redactSecretsWithReport, shannonEntropy } from '../src/secrets';
import { isGeneratedProjectContext } from '../src/browserFs';

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

// Same corpus as `secret_scanner_fp_fn_corpus_evaluation` in tests/phase1_regressions.rs.
test('fixture corpus: 21/21 true positives and 0/20 false positives', () => {
  const truePositives: [string, string][] = [
    [['-----BEGIN ', 'PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END ', 'PRIVATE KEY-----'].join(''), 'PRIVATE_KEY'],
    [['AK', 'IAIOSFODNN7EXAMPLE'].join(''), 'AWS_ACCESS_KEY'],
    [['sk-ant-', 'api03-abcdefghijklmnopqrstuvwx'].join(''), 'ANTHROPIC_API_KEY'],
    [['sk-', 'abcdefghijklmnopqrstuvwx'].join(''), 'OPENAI_API_KEY'],
    [['AIza', 'SyDaGmWKa4JsXZ-HjGw7xAAAAAAAAA12345'].join(''), 'GOOGLE_API_KEY'],
    [['sk_live_', '51Habcdefghijklmnopqrstuvwx'].join(''), 'STRIPE_KEY'],
    [['ghp_', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'].join(''), 'GITHUB_TOKEN'],
    [['xoxb-', '1234567890-abcdefghij'].join(''), 'SLACK_TOKEN'],
    [['postgres://admin:', 's3cr3tPass', '@db.internal:5432/app'].join(''), 'URL_PASSWORD'],
    [['Server=db;Password=', 'Sup3r'].join(''), 'PASSWORD'],
    [['JWT_SECRET=', 'super-secret-jwt-signing-key-999'].join(''), 'ENV_SECRET'],
    [['glpat-', 'abcdefghijklmnopqrst0123'].join(''), 'GITLAB_TOKEN'],
    [['hf_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(''), 'HUGGINGFACE_TOKEN'],
    [['npm_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(''), 'NPM_TOKEN'],
    [
      ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N'].join('.'),
      'JWT_TOKEN',
    ],
    [['github_pat_', '11AAABBBCCC0123456789_abcdefghijklmnopqrstuvwx'].join(''), 'GITHUB_TOKEN'],
    [['DB_PASSWORD=', 'Sup3rSecretEnvPass'].join(''), 'PASSWORD'],
    [
      [
        'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=',
        '4kF7+s9ZbQ2mN8xL1vP0wR5tY6uI3oE8aBcDeFgHiJk=',
        ';EndpointSuffix=core.windows.net',
      ].join(''),
      'AZURE_KEY',
    ],
    [
      ['SG.', '1234567890123456789012', '.', '1234567890123456789012345678901234567890123'].join(''),
      'SENDGRID_KEY',
    ],
    [['MTAw', 'MDAwMDAwMDAwMDAwMDAwMA.G12345.123456789012345678901234567'].join(''), 'DISCORD_TOKEN'],
    [['api_key: "', '4kF7+s9ZbQ2mN8xL1vP0wR5tY6uI3oE=', '"'].join(''), 'HIGH_ENTROPY_SECRET'],
  ];
  let caught = 0;
  for (const [sample, kind] of truePositives) {
    const { text: redacted } = redactSecretsWithReport(sample);
    expect(redacted, kind).toContain(`[REDACTED: ${kind}]`);
    caught += 1;
  }
  expect(caught).toBe(21);

  const trueNegatives: string[] = [
    'id = 123e4567-e89b-12d3-a456-426614174000;',
    'sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==">',
    '<div class="btn btn-primary text-center mt-4">',
    'const map: Map<string, Array<number>> = new Map();',
    'SELECT id, name FROM users WHERE active = 1 ORDER BY name;',
    'if (a == b && c != d) { return a >= 0; }',
    'Replace <your-token> with a real value from the dashboard.',
    'fn verify(password: &str) -> bool { hash(password) == stored }',
    'git commit -m "fix: sk-learn import order"',
    'See [the docs](https://example.com/docs/getting-started) for details.',
    'Dev server: http://localhost:3000/api/users',
    'color: #1a2b3c; background: rgba(0, 0, 0, 0.5);',
    'createdAt: 2026-10-14T12:00:00Z',
    'commit 9fceb02d0ae598e95dc970b74767f19372d61af8',
    '"@scope/package-name": "^1.2.3"',
    'const token = process.env.API_TOKEN;',
    'export const TOKEN_LIMIT = 4096;',
    'MAX_SECRET_LENGTH=32',
    'headers["X-CSRF-Token"] = csrfToken;',
  ];
  expect(trueNegatives.length).toBe(20);
  let falsePositives = 0;
  for (const sample of trueNegatives) {
    const { text: redacted, summary } = redactSecretsWithReport(sample);
    if (summary.totalRedactions > 0 || redacted !== sample) falsePositives += 1;
  }
  expect(falsePositives).toBe(0);
});

test('leaves ordinary code unchanged', () => {
  const text = 'let task = skip_list;\npassword_hint = "use a manager";\nlet key = sk;\n';
  expect(redactSecrets(text)).toBe(text);
});

test('adversarial near-miss input completes within bounded time', () => {
  const chunk = 'sk-short AKIA12345 eyJabc.eyJdef.short http://user: in_code_password = 1;\n';
  const payload = chunk.repeat(5000);
  const t0 = Date.now();
  const { text, summary } = redactSecretsWithReport(payload);
  const elapsed = Date.now() - t0;
  expect(summary.totalRedactions).toBe(0);
  expect(text.length).toBe(payload.length);
  expect(elapsed).toBeLessThan(500);
});

test('masks new token types: Azure, SendGrid, Discord, and High Entropy Secrets', () => {
  const azure = ['AccountKey=', '4kF7+s9ZbQ2mN8xL1vP0wR5tY6uI3oE8aBcDeFgHiJk='].join('');
  const sendgrid = ['SG.', '1234567890123456789012', '.', '1234567890123456789012345678901234567890123'].join('');
  const discord = ['MTAw', 'MDAwMDAwMDAwMDAwMDAwMA.G12345.123456789012345678901234567'].join('');
  const highEntropy = ['auth_token: "', '4kF7+s9ZbQ2mN8xL1vP0wR5tY6uI3oE=', '"'].join('');

  const input = [
    `azure = "${azure}";`,
    `sendgrid = "${sendgrid}";`,
    `discord = "${discord}";`,
    highEntropy,
  ].join('\n');

  const { text: redacted, summary } = redactSecretsWithReport(input);

  expect(redacted).toContain('AccountKey=[REDACTED: AZURE_KEY]');
  expect(redacted).toContain('[REDACTED: SENDGRID_KEY]');
  expect(redacted).toContain('[REDACTED: DISCORD_TOKEN]');
  expect(redacted).toContain('auth_token: "[REDACTED: HIGH_ENTROPY_SECRET]"');
  expect(summary.totalRedactions).toBe(4);

  // Shannon entropy helper verification
  expect(shannonEntropy('')).toBe(0);
  expect(shannonEntropy('aaaaa')).toBe(0);
  expect(shannonEntropy('01234567890123456789012345678901')).toBeLessThan(3.5);
  expect(shannonEntropy('4kF7+s9ZbQ2mN8xL1vP0wR5tY6uI3oE=')).toBeGreaterThan(4.5);

  // Placeholders and low entropy must NOT be redacted by HIGH_ENTROPY_SECRET
  const benignAssignment1 = 'client_key: "your_api_key_here_replace_this_token"';
  const benignAssignment2 = 'auth_token: "01234567890123456789012345678901"';
  const benignAssignment3 = 'bearer_token: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"';
  expect(redactSecrets(benignAssignment1)).toBe(benignAssignment1);
  expect(redactSecrets(benignAssignment2)).toBe(benignAssignment2);
  expect(redactSecrets(benignAssignment3)).toBe(benignAssignment3);
});

test('isGeneratedProjectContext identifies all 4 formats and prevents self-packing', () => {
  const xmlArtifact =
    '<project_context>\n  <source>This file was generated by ptt (ProjectToText) from my_project</source>\n</project_context>';
  const jsonArtifact = '{\n  "generator": "ptt (ProjectToText)",\n  "file_count": 5\n}';
  const jsonBrowserArtifact = '{\n  "generator": "ptt (ProjectToText) browser-mode",\n  "file_count": 5\n}';
  const mdArtifact =
    '# Project Context\nGenerated from: `my_project`\nReading info: Files processed with size/binary limits (max 2097152 bytes) and encoding handling.\n\n## Directory Structure\n';
  const mdBrowserArtifact =
    '# Project Context\nGenerated from: `my_project` (browser mode)\nReading info: Files processed with size/binary limits (max 2097152 bytes) and encoding handling.\n';
  const plainArtifact =
    'Project: my_project\nReading info: Data read with limits (2097152 bytes), binary skip, UTF-8 / BOM-declared UTF-16.\n================================\n';

  expect(isGeneratedProjectContext(xmlArtifact)).toBe(true);
  expect(isGeneratedProjectContext(jsonArtifact)).toBe(true);
  expect(isGeneratedProjectContext(jsonBrowserArtifact)).toBe(true);
  expect(isGeneratedProjectContext(mdArtifact)).toBe(true);
  expect(isGeneratedProjectContext(mdBrowserArtifact)).toBe(true);
  expect(isGeneratedProjectContext(plainArtifact)).toBe(true);

  // Normal code files mentioning ptt or context must NOT be flagged
  const regularFile1 = 'fn main() { println!("This file was generated by ptt (ProjectToText)"); }';
  const regularFile2 = '# Project Context\nSome documentation about context';
  const regularFile3 = '{"generator": "other-tool"}';
  expect(isGeneratedProjectContext(regularFile1)).toBe(false);
  expect(isGeneratedProjectContext(regularFile2)).toBe(false);
  expect(isGeneratedProjectContext(regularFile3)).toBe(false);
});

