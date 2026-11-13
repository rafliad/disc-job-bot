import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { ownerId, friendId, guildId, signedRequest } from './helpers';

const app = '888888888888888888';
const prompt = '999999999999999999';
const thread = '666666666666666666';
const forum = '333333333333333333';
const otherForum = '444444444444444444';
const bot = '777777777777777777';

async function seed(user = ownerId, channel = forum, linked: string | null = thread) {
	await env.disc_tracker_db.prepare(`INSERT INTO applications
		(id, owner_discord_id, forum_channel_id, discord_thread_id, company, position, applied_at)
		VALUES (?, ?, ?, ?, 'Example Company', 'Engineer', '2026-11-13')`).bind(app, user, channel, linked).run();
}
const command = (user = ownerId, id = prompt) => ({
	type: 2, id, application_id: bot, guild_id: guildId, member: { user: { id: user } },
	data: { type: 1, name: 'delete', options: [{ type: 3, name: 'application', value: app }] },
});
const button = (action = 'confirm', user = ownerId, id = prompt) => ({
	...command(user), type: 3, id: '282828282828282828', token: 'delete-fixture-token',
	data: { component_type: 2, custom_id: `delete:${action}:${id}` },
});
async function run(payload: unknown, bindings: Env = env) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(await signedRequest(JSON.stringify(payload)), bindings, ctx);
	expect(response.status).toBe(200);
	const reply = await response.json<any>();
	await waitOnExecutionContext(ctx);
	return reply;
}
const row = () => env.disc_tracker_db.prepare('SELECT * FROM applications WHERE id = ?').bind(app).first();
const receipt = () => env.disc_tracker_db.prepare('SELECT * FROM application_deletions WHERE id = ?').bind(prompt).first();
function discord(options: { parent?: string; preflight?: number; deletion?: number; badBody?: boolean;
	throws?: boolean; gate?: Promise<void>; started?: () => void } = {}) {
	const calls: { method: string; path: string; body: any }[] = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const request = new Request(String(input), init);
		const path = new URL(request.url).pathname;
		calls.push({ method: request.method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
		if (path.includes('/webhooks/')) return Response.json({});
		if (path === `/api/v10/channels/${forum}` || path === `/api/v10/channels/${otherForum}`)
			return Response.json({ id: path.split('/').at(-1), guild_id: guildId, type: 15 });
		if (path !== `/api/v10/channels/${thread}`) throw new Error('Unexpected mocked path');
		const target = { id: thread, type: 11, guild_id: guildId, parent_id: options.parent ?? forum,
			thread_metadata: { archived: true, locked: true } };
		if (request.method === 'GET') return Response.json(target, { status: options.preflight ?? 200 });
		if (request.method !== 'DELETE') throw new Error('Unexpected mocked method');
		options.started?.();
		await options.gate;
		if (options.throws) throw new Error('fixture network failure');
		return Response.json(options.badBody ? {} : target, { status: options.deletion ?? 200 });
	});
	return calls;
}
afterEach(() => vi.restoreAllMocks());

describe('/delete', () => {
	it('shows an owned private confirmation and leaves the application unlocked', async () => {
		await seed(); const calls = discord();
		const reply = await run(command());
		expect(reply).toMatchObject({ type: 4, data: { flags: 64, allowed_mentions: { parse: [] } } });
		expect(reply.data.content).toContain('Example Company');
		expect(reply.data.content).toContain(`<https://discord.com/channels/${guildId}/${thread}>`);
		expect(reply.data.components[0].components.map((c: any) => [c.label, c.custom_id]))
			.toEqual([['Delete', `delete:confirm:${prompt}`], ['Cancel', `delete:cancel:${prompt}`]]);
		expect((await row())?.status_change_id).toBeNull();
		expect(calls).toEqual([]);
	});

	it('only suggests the invoking owner’s linked application', async () => {
		await seed(); const payload = (user: string) => ({
			...command(user), type: 4, data: { type: 1, name: 'delete', options: [{ type: 3, name: 'application', value: 'example', focused: true }] },
		});
		expect((await run(payload(ownerId))).data.choices).toMatchObject([{ value: app }]);
		expect((await run(payload(friendId))).data.choices).toEqual([]);
	});

	it.each(['other owner', 'wrong Forum', 'unlinked'])('does not offer deletion for %s', async (kind) => {
		await seed(kind === 'other owner' ? friendId : ownerId, kind === 'wrong Forum' ? otherForum : forum, kind === 'unlinked' ? null : thread);
		const calls = discord();
		const reply = await run(command());
		expect(reply.data.components).toBeUndefined();
		expect(JSON.stringify(reply)).not.toContain('Example Company');
		expect(calls).toEqual([]);
	});

	it('cannot confirm someone else’s prompt or a nonexistent prompt', async () => {
		await seed(); const calls = discord(); await run(command());
		await run(button('confirm', friendId)); await run(button('confirm', ownerId, '222222222222222229'));
		expect(await row()).not.toBeNull(); expect(calls.every(c => c.path.includes('/webhooks/'))).toBe(true);
	});

	it('cancels without a Discord channel request and cannot confirm a cancelled prompt', async () => {
		await seed(); const calls = discord(); await run(command());
		expect(await run(button('cancel'))).toEqual({ type: 6 });
		expect(calls.at(-1)?.body).toMatchObject({ content: 'Deletion cancelled.', components: [] });
		await run(button());
		expect(await row()).not.toBeNull(); expect(await receipt()).toMatchObject({ state: 'cancelled' });
		expect(calls.every(c => c.path.includes('/webhooks/'))).toBe(true);
	});

	it.each(['expired', 'edited', 'status changed', 'claimed'])('rejects a %s confirmation', async (kind) => {
		await seed(); const calls = discord(); await run(command());
		const db = env.disc_tracker_db;
		if (kind === 'expired') await db.prepare('UPDATE application_deletions SET expires_at = 0').run();
		if (kind === 'edited') await db.prepare('UPDATE applications SET details_version = 1').run();
		if (kind === 'status changed') await db.prepare("UPDATE applications SET status = 'Interview'").run();
		if (kind === 'claimed') await db.prepare("UPDATE applications SET status_change_id = 'existing'").run();
		await run(button());
		expect(await row()).not.toBeNull();
		expect(calls.every(c => c.path.includes('/webhooks/'))).toBe(true);
		expect(await receipt()).toMatchObject({ state: 'failed' });
	});

	it('deletes the exact archived post once, removes dependent records, and blocks delayed /apply', async () => {
		await seed(); const calls = discord(); await run(command());
		await env.disc_tracker_db.prepare("INSERT INTO status_changes (id,application_id,from_status,to_status) VALUES ('old',?,'Applied','Offer')").bind(app).run();
		await env.disc_tracker_db.prepare("INSERT INTO application_edits (id,application_id,base_version,before_details) VALUES ('old',?,0,'{}')").bind(app).run();
		expect(await run(button())).toEqual({ type: 6 });
		expect(calls.at(-1)?.body.content).toBe('Application and Forum post deleted.');
		await run(button());
		expect(calls.filter(c => c.method === 'DELETE').map(c => c.path)).toEqual([`/api/v10/channels/${thread}`]);
		expect(await row()).toBeNull(); expect(await receipt()).toMatchObject({ state: 'complete' });
		for (const table of ['status_changes', 'application_edits']) {
			expect(await env.disc_tracker_db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(0);
		}
		const apply = { ...button(), type: 5, data: { custom_id: `apply:${app}:${ownerId}`, components: [
			{ type: 18, component: { type: 4, custom_id: 'company', value: 'Example Company' } },
			{ type: 18, component: { type: 4, custom_id: 'position', value: 'Engineer' } },
		] } };
		await run(apply);
		expect(await row()).toBeNull(); expect(calls.some(c => c.method === 'POST')).toBe(false);
		expect(calls.at(-1)?.body.content).toContain('deleted');
	});

	it('serializes concurrent confirmation clicks and refuses cancellation during deletion', async () => {
		await seed(); let start!: () => void; let release!: () => void;
		const started = new Promise<void>(r => start = r), gate = new Promise<void>(r => release = r);
		const calls = discord({ gate, started: start }); await run(command());
		const first = run(button());
		try { await started; await run(button()); await run(button('cancel')); }
		finally { release(); await first; }
		expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(1);
		expect(await receipt()).toMatchObject({ state: 'complete' });
	});

	it('surfaces a recovery reference for a stalled claim without retrying DELETE', async () => {
		await seed(); const calls = discord(); await run(command());
		await env.disc_tracker_db.batch([
			env.disc_tracker_db.prepare("UPDATE application_deletions SET state = 'pending', claimed_at = unixepoch() - 61 WHERE id = ?").bind(prompt),
			env.disc_tracker_db.prepare('UPDATE applications SET status_change_id = ? WHERE id = ?').bind(prompt, app),
		]);
		await run(button()); await run(button('cancel'));
		expect(await row()).toMatchObject({ status_change_id: prompt });
		expect(await receipt()).toMatchObject({ state: 'pending' });
		expect(calls).toHaveLength(2);
		expect(calls.every(c => c.path.includes('/webhooks/') && c.body.content.includes(prompt))).toBe(true);
	});

	it.each([{ parent: otherForum }, { preflight: 404 }, { deletion: 403 }, { deletion: 429 }])
	('releases the claim after a definite failure %j', async options => {
		await seed(); const calls = discord(options); await run(command()); await run(button());
		expect(await row()).toMatchObject({ status_change_id: null });
		expect(await receipt()).toMatchObject({ state: 'failed' });
		expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(options.deletion ? 1 : 0);
	});

	it.each([{ deletion: 500 }, { deletion: 404 }, { deletion: 302 }, { badBody: true }, { throws: true }])
	('keeps the claimed record for uncertain Discord results %j', async options => {
		await seed(); const calls = discord(options); await run(command()); await run(button()); await run(button());
		expect(await row()).toMatchObject({ status_change_id: prompt });
		expect(await receipt()).toMatchObject({ state: 'needs_check' });
		expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(1);
		expect(calls.at(-1)?.body.content).toContain(prompt);
	});

	it('retains recovery information if Discord deletes the thread but the D1 commit fails', async () => {
		await seed(); const calls = discord(); await run(command());
		const db = env.disc_tracker_db;
		const bindings = { ...env, disc_tracker_db: {
			prepare(sql: string) { if (sql.startsWith('DELETE FROM applications')) throw new Error('fixture database failure'); return db.prepare(sql); },
			batch: db.batch.bind(db),
		} as unknown as D1Database };
		await run(button(), bindings);
		expect(await row()).toMatchObject({ status_change_id: prompt });
		expect(await receipt()).toMatchObject({ state: 'needs_check', failure_stage: 'database_commit' });
		expect(calls.at(-1)?.body.content).toContain(prompt);
	});
});
