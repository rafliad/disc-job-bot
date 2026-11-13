import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as nodeTest } from 'node:test';

const commandDefinitions = [
	{ name: 'delete', description: 'Permanently delete one of your job applications.', options: [
		{ type: 3, name: 'application', description: 'Your job application', required: true, autocomplete: true },
	] },
	{ name: 'edit', description: 'Edit details of one of your job applications.', options: [
		{ type: 3, name: 'application', description: 'Your job application', required: true, autocomplete: true },
	] },
	{ name: 'test', description: 'Check that Job Tracker is connected.' },
	{ name: 'apply', description: 'Track a new job application in your Forum.' },
	{ name: 'status', description: 'Update one of your job applications.', options: [
		{ type: 3, name: 'application', description: 'Your job application', required: true, autocomplete: true },
		{ type: 3, name: 'status', description: 'New application status', required: true,
			choices: ['Applied','Screening','Assessment','Interview','Offer','Rejected','Withdrawn'].map(name=>({name,value:name})) },
	] },
];
for (const definition of commandDefinitions) {
	const test = (name, fn) => nodeTest(`${definition.name}: ${name}`, fn);
	const script = fileURLToPath(new URL(`../scripts/register-${definition.name}-command.mjs`, import.meta.url));
	const guildId = '123456789012345678';
	const applicationId = '234567890123456789';
	const fixtureToken = 'test-only-token';

	// Exercise the real CLI in a temporary folder with fake credentials and a fake
	// HTTP boundary. No test can register commands or contact Discord.
	function runRegistration({ args = [guildId], credentials = true, status = 201, networkError = false } = {}) {
		const cwd = mkdtempSync(join(tmpdir(), 'tracker-register-'));
		const requestLog = join(cwd, 'request.json');
		try {
			if (credentials) {
				writeFileSync(join(cwd, '.dev.vars'), `DISCORD_APPLICATION_ID="${applicationId}"\nDISCORD_TOKEN="${fixtureToken}"\n`);
			}
			const mockHttp = `
				import { writeFileSync } from 'node:fs';
				globalThis.fetch = async (url, options) => {
					writeFileSync(${JSON.stringify(requestLog)}, JSON.stringify({
						url: String(url), method: options.method,
						headers: Object.fromEntries(new Headers(options.headers)),
						body: JSON.parse(options.body),
					}));
					if (${networkError}) throw new Error(${JSON.stringify(fixtureToken)});
					return new Response(${JSON.stringify(fixtureToken)}, { status: ${status} });
				};
			`;
			const preload = `data:text/javascript;base64,${Buffer.from(mockHttp).toString('base64')}`;
			const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DISCORD_')));
			const result = spawnSync(process.execPath, ['--import', preload, script, ...args], { cwd, env, encoding: 'utf8' });
			const request = existsSync(requestLog) ? JSON.parse(readFileSync(requestLog, 'utf8')) : null;
			return { ...result, request };
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}

	test(`registers only /${definition.name} for the specified guild using local credentials`, () => {
		const result = runRegistration();
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.request.url, `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`);
		assert.equal(result.request.method, 'POST');
		assert.equal(result.request.headers.authorization, `Bot ${fixtureToken}`);
		assert.deepEqual(result.request.body, { type: 1, name: definition.name, description: definition.description,
			...(definition.options ? { options: definition.options } : {}) });
		assert.match(result.stdout, new RegExp(`Registered /${definition.name}`));
		assert.ok(!`${result.stdout}${result.stderr}`.includes(fixtureToken));
	});

	test('accepts an existing command update response', () => {
		const result = runRegistration({ status: 200 });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, new RegExp(`Registered /${definition.name}`));
	});

	for (const args of [[], ['not-an-id'], [guildId, 'unexpected-extra-argument']]) {
		test(`rejects invalid command-line arguments ${JSON.stringify(args)} without an API request`, () => {
			const result = runRegistration({ args });
			assert.equal(result.status, 1);
			assert.match(result.stderr, /server ID|Usage/);
			assert.equal(result.request, null);
		});
	}

	test('rejects missing credentials without an API request', () => {
		const result = runRegistration({ credentials: false });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /DISCORD_APPLICATION_ID|DISCORD_TOKEN/);
		assert.equal(result.request, null);
	});

	for (const status of [401, 403, 429]) {
		test(`reports HTTP ${status} without printing API responses or credentials`, () => {
			const result = runRegistration({ status });
			assert.equal(result.status, 1);
			assert.match(result.stderr, new RegExp(`HTTP ${status}`));
			assert.ok(!`${result.stdout}${result.stderr}`.includes(fixtureToken));
		});
	}

	test('reports a network failure without printing a possibly sensitive error', () => {
		const result = runRegistration({ networkError: true });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Could not reach Discord/);
		assert.ok(!`${result.stdout}${result.stderr}`.includes(fixtureToken));
	});

}
