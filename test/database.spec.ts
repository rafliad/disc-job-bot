import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, inject, it } from 'vitest';

function insert(id: string, owner = '111111111111111111', thread: string | null = null) {
	return env.disc_tracker_db.prepare(`
		INSERT INTO applications (id, owner_discord_id, forum_channel_id, discord_thread_id, company, position, applied_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).bind(id, owner, '333333333333333333', thread, 'Example Company', 'Software Engineer', '2026-10-11');
}

describe('application migration', () => {
	it('stores owner IDs as exact strings, optional fields as null, and defaults to Applied', async () => {
		await insert('application-1', '222222222222222222').run();
		const row = await env.disc_tracker_db.prepare('SELECT * FROM applications WHERE id = ?').bind('application-1').first();
		expect(row).toMatchObject({
			id: 'application-1', owner_discord_id: '222222222222222222',
			discord_thread_id: null, job_url: null, source: null, notes: null,
			status: 'Applied', applied_at: '2026-10-11',
		});
		expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
		expect(row?.updated_at).toBe(row?.created_at);
	});

	it('allows multiple pending applications without a thread', async () => {
		await insert('pending-1').run();
		await insert('pending-2').run();
		expect(await env.disc_tracker_db.prepare('SELECT COUNT(*) AS count FROM applications').first('count')).toBe(2);
	});

	it('prevents duplicate application IDs and duplicate Discord threads', async () => {
		await insert('application-1', undefined, '666666666666666666').run();
		await expect(insert('application-1').run()).rejects.toThrow(/UNIQUE/);
		await expect(insert('application-2', undefined, '666666666666666666').run()).rejects.toThrow(/UNIQUE/);
	});

	it.each(['Applied', 'Screening', 'Assessment', 'Interview', 'Offer', 'Rejected', 'Withdrawn'])('allows status %s', async (status) => {
		await insert('application-1').run();
		await env.disc_tracker_db.prepare('UPDATE applications SET status = ? WHERE id = ?').bind(status, 'application-1').run();
		expect(await env.disc_tracker_db.prepare('SELECT status FROM applications WHERE id = ?').bind('application-1').first('status')).toBe(status);
	});

	it.each([
		{ column: 'status', value: 'Unknown' },
		{ column: 'company', value: '   ' },
		{ column: 'position', value: '' },
		{ column: 'owner_discord_id', value: null },
		{ column: 'id', value: null },
	])('rejects invalid $column', async ({ column, value }) => {
		await insert('application-1').run();
		// Column names come only from the fixed test cases, values are bound.
		await expect(env.disc_tracker_db.prepare(`UPDATE applications SET ${column} = ? WHERE id = ?`)
			.bind(value, 'application-1').run()).rejects.toThrow(/constraint/i);
	});

	it('keeps existing data when the migration runner is invoked again', async () => {
		await insert('existing').run();
		await applyD1Migrations(env.disc_tracker_db, inject('migrations'));
		expect(await env.disc_tracker_db.prepare('SELECT id FROM applications').first('id')).toBe('existing');
	});

	it('preserves a populated 0001 database when adding status-change tracking', async () => {
		const db = env.disc_tracker_db;
		// Rebuild only this isolated test's database at the pre-upgrade schema.
		await db.batch([db.prepare('DROP TABLE IF EXISTS application_edits'), db.prepare('DROP TABLE status_changes'), db.prepare('DROP TABLE applications')]);
		const migrations = inject('migrations');
		await applyD1Migrations(db, migrations.slice(0,1), 'upgrade_test_migrations');
		await insert('existing', undefined, '666666666666666666').run();
		await db.prepare(`UPDATE applications SET status = 'Offer', job_url = 'https://example.com/job',
			source = 'Referral', notes = 'Keep this note' WHERE id = 'existing'`).run();
		const before = await db.prepare('SELECT * FROM applications').first();
		await applyD1Migrations(db, migrations.slice(0,2), 'upgrade_test_migrations');
		expect(await db.prepare('SELECT * FROM applications').first()).toEqual({...before, status_change_id:null});
		expect(await db.prepare('SELECT COUNT(*) AS count FROM status_changes').first('count')).toBe(0);
	});

	it('preserves populated applications and status attempts when adding edits',async()=>{
		const db=env.disc_tracker_db;
		await db.batch([db.prepare('DROP TABLE IF EXISTS application_edits'),db.prepare('DROP TABLE status_changes'),db.prepare('DROP TABLE applications')]);
		const migrations=inject('migrations');await applyD1Migrations(db,migrations.slice(0,2),'edit_upgrade_migrations');
		await insert('existing',undefined,'666666666666666666').run();
		await db.prepare(`INSERT INTO status_changes (id,application_id,from_status,to_status,state) VALUES ('previous','existing','Applied','Offer','complete')`).run();
		const before=await db.prepare('SELECT * FROM applications').first();const previous=await db.prepare('SELECT * FROM status_changes').first();
		await applyD1Migrations(db,migrations.slice(0,3),'edit_upgrade_migrations');
		expect(await db.prepare('SELECT * FROM applications').first()).toEqual({...before,details_version:0});
		expect(await db.prepare('SELECT * FROM status_changes').first()).toEqual(previous);
		expect(await db.prepare('SELECT COUNT(*) AS count FROM application_edits').first('count')).toBe(0);
	});

	it('indexes owner and update time for owner-scoped queries', async () => {
		const { results } = await env.disc_tracker_db.prepare("PRAGMA index_info('applications_owner_updated_idx')").all();
		expect(results.map((column) => column.name)).toEqual(['owner_discord_id', 'updated_at']);
	});
});
