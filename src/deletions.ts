import { isDiscordId, isRecord } from './apply-form';
import type { UserForum } from './authorization';
import { discordRequest, editPrivateReply, noMentions } from './discord';

type DeleteAction = 'confirm' | 'cancel';
interface Deletion {
	id: string;
	application_id: string;
	discord_thread_id: string;
	claim_stalled: number;
	state: 'open' | 'cancelled' | 'pending' | 'complete' | 'failed' | 'needs_check';
}

const privateMessage = (content: string) => ({ type: 4, data: { content, flags: 64, allowed_mentions: noMentions } });
const unavailable = 'This application is unavailable. Choose one of your saved applications with /delete.';
const confirmed = 'Application and Forum post deleted.';
const cancelled = 'Deletion cancelled.';
const invalid = 'This confirmation expired or the application changed or is busy. Run /delete again when it is ready.';
const needsCheck = (id: string) => `Deletion needs checking. Check the Forum and database before trying again. Reference: ${id}.`;

export function parseDeleteButton(data: unknown): { action: DeleteAction; promptId: string } | null {
	if (!isRecord(data) || data.component_type !== 2 || typeof data.custom_id !== 'string') return null;
	const match = /^delete:(confirm|cancel):([1-9]\d{16,19})$/.exec(data.custom_id);
	if (!match) return null;
	return { action: match[1] === 'confirm' ? 'confirm' : 'cancel', promptId: match[2] };
}

export async function openDelete(app: string, user: UserForum, id: string, env: Env): Promise<Response> {
	try {
		// Snapshot the displayed details and revision in one statement without taking the mutation claim.
		const target = await env.disc_tracker_db.prepare(`INSERT INTO application_deletions
			(id, application_id, owner_discord_id, forum_channel_id, discord_thread_id,
			 details_version, status, application_updated_at, expires_at)
			SELECT ?, id, owner_discord_id, forum_channel_id, discord_thread_id, details_version,
			       status, updated_at, unixepoch() + 600
			FROM applications WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ?
				AND discord_thread_id IS NOT NULL AND status_change_id IS NULL
			ON CONFLICT(id) DO NOTHING
			RETURNING discord_thread_id,
				(SELECT company FROM applications WHERE id = ?) AS company,
				(SELECT position FROM applications WHERE id = ?) AS position`)
			.bind(id, app, user.ownerDiscordId, user.forumChannelId, app, app)
			.first<{ discord_thread_id: string; company: string; position: string }>();
		if (!target || !isDiscordId(target.discord_thread_id)) return Response.json(privateMessage(unavailable));
		return Response.json({
			type: 4,
			data: {
				flags: 64, allowed_mentions: noMentions,
				content: `Delete **${target.company} — ${target.position}**? This permanently removes the application, its Forum post, and its history. The confirmation expires in 10 minutes.\nPost: <https://discord.com/channels/${env.DISCORD_GUILD_ID}/${target.discord_thread_id}>`,
				components: [{ type: 1, components: [
					{ type: 2, style: 4, label: 'Delete', custom_id: `delete:confirm:${id}` },
					{ type: 2, style: 2, label: 'Cancel', custom_id: `delete:cancel:${id}` },
				] }],
			},
		});
	} catch {
		return Response.json(privateMessage('Could not prepare deletion. Check the database and run /delete again.'));
	}
}

function isTarget(data: unknown, thread: string, user: UserForum, env: Env) {
	return isRecord(data) && data.id === thread && data.type === 11 &&
		data.guild_id === env.DISCORD_GUILD_ID && data.parent_id === user.forumChannelId;
}

async function lookup(id: string, user: UserForum, db: D1Database) {
	return db.prepare(`SELECT id, application_id, discord_thread_id, state,
		COALESCE(claimed_at <= unixepoch() - 60, 1) AS claim_stalled FROM application_deletions
		WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ?`)
		.bind(id, user.ownerDiscordId, user.forumChannelId).first<Deletion>();
}

function outcome(row: Deletion | null): string | null {
	switch (row?.state) {
		case 'pending': return row.claim_stalled ? needsCheck(row.id) : null; // A live click will update the prompt.
		case 'complete': return confirmed;
		case 'cancelled': return cancelled;
		case 'needs_check': return needsCheck(row.id);
		case 'failed': return invalid;
		default: return 'This confirmation is unavailable. Run /delete again.';
	}
}

async function finishFailed(row: Deletion, user: UserForum, db: D1Database, stage: string, uncertain: boolean) {
	const mark = db.prepare(`UPDATE application_deletions SET state = ?, failure_stage = ?
		WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ? AND state = 'pending'`)
		.bind(uncertain ? 'needs_check' : 'failed', stage, row.id, user.ownerDiscordId, user.forumChannelId);
	if (uncertain) {
		await mark.run();
		return;
	}
	await db.batch([mark, db.prepare(`UPDATE applications SET status_change_id = NULL
		WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ? AND status_change_id = ?
			AND EXISTS (SELECT 1 FROM application_deletions WHERE id = ? AND state = 'failed')`)
		.bind(row.application_id, user.ownerDiscordId, user.forumChannelId, row.id, row.id)]);
}

async function deleteApplication(id: string, action: DeleteAction, user: UserForum, env: Env): Promise<string | null> {
	const db = env.disc_tracker_db;
	const { ownerDiscordId: owner, forumChannelId: forum } = user;
	const row = await lookup(id, user, db);
	if (row?.state !== 'open') return outcome(row);

	if (action === 'cancel') {
		const result = await db.prepare(`UPDATE application_deletions SET state = 'cancelled'
			WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ? AND state = 'open'`)
			.bind(id, owner, forum).run();
		return result.meta.changes === 1 ? cancelled : outcome(await lookup(id, user, db));
	}

	const [claim, pending, failed] = await db.batch([
		db.prepare(`UPDATE applications SET status_change_id = ?
			WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ? AND status_change_id IS NULL
				AND EXISTS (SELECT 1 FROM application_deletions d
					WHERE d.id = ? AND d.owner_discord_id = ? AND d.forum_channel_id = ?
						AND d.state = 'open' AND d.expires_at > unixepoch()
						AND d.application_id = applications.id AND d.discord_thread_id = applications.discord_thread_id
						AND d.details_version = applications.details_version AND d.status = applications.status
						AND d.application_updated_at = applications.updated_at)`)
			.bind(id, row.application_id, owner, forum, id, owner, forum),
		db.prepare(`UPDATE application_deletions SET state = 'pending', claimed_at = unixepoch()
			WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ? AND state = 'open'
				AND EXISTS (SELECT 1 FROM applications a WHERE a.id = application_deletions.application_id
					AND a.owner_discord_id = ? AND a.forum_channel_id = ? AND a.status_change_id = ?)`)
			.bind(id, owner, forum, owner, forum, id),
		db.prepare(`UPDATE application_deletions SET state = 'failed', failure_stage = 'claim'
			WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ? AND state = 'open'`)
			.bind(id, owner, forum),
	]);
	if (claim.meta.changes !== 1 || pending.meta.changes !== 1) {
		return failed.meta.changes === 1 ? invalid : outcome(await lookup(id, user, db));
	}

	let stage = 'preflight';
	let uncertain = false;
	let failureMessage = 'Could not verify that the post belongs to your Forum. Check the post before trying again.';
	try {
		const thread = row.discord_thread_id;
		if (!isDiscordId(thread) || thread === forum) throw new Error('Invalid saved thread');
		const [parent, post] = await Promise.all([
			discordRequest(`/channels/${forum}`, env.DISCORD_TOKEN),
			discordRequest(`/channels/${thread}`, env.DISCORD_TOKEN),
		]);
		if (!parent.ok || !post.ok) throw new Error('Preflight rejected');
		const parentData: unknown = await parent.json();
		if (!isRecord(parentData) || parentData.id !== forum || parentData.type !== 15 ||
			parentData.guild_id !== env.DISCORD_GUILD_ID || !isTarget(await post.json(), thread, user, env))
			throw new Error('Wrong Forum or post');

		stage = 'discord_delete';
		uncertain = true;
		const deleted = await discordRequest(`/channels/${thread}`, env.DISCORD_TOKEN, 'DELETE');
		if ([400, 401, 403, 429].includes(deleted.status)) {
			uncertain = false;
			failureMessage = deleted.status === 429 ? 'Discord is rate limiting requests. Wait a moment and run /delete again.'
				: 'Discord refused to delete the post. Check bot access and Manage Threads permission.';
			throw new Error('Discord refused deletion');
		}
		if (!deleted.ok || !isTarget(await deleted.json(), thread, user, env)) throw new Error('Unconfirmed deletion');

		stage = 'database_commit';
		const [marked, removed] = await db.batch<{ id: string }>([
			db.prepare(`UPDATE application_deletions SET state = 'complete', failure_stage = NULL
				WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ? AND state = 'pending'
					AND EXISTS (SELECT 1 FROM applications WHERE id = application_deletions.application_id
						AND owner_discord_id = ? AND forum_channel_id = ? AND discord_thread_id = ? AND status_change_id = ?)`)
				.bind(id, owner, forum, owner, forum, thread, id),
			db.prepare(`DELETE FROM applications WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ?
				AND discord_thread_id = ? AND status_change_id = ?
				AND EXISTS (SELECT 1 FROM application_deletions WHERE id = ? AND state = 'complete') RETURNING id`)
				.bind(row.application_id, owner, forum, thread, id, id),
		]);
		// D1 counts cascaded edit/status rows in meta.changes; RETURNING identifies the direct delete.
		if (marked.meta.changes !== 1 || removed.results.length !== 1 || removed.results[0].id !== row.application_id) throw new Error('Deletion commit did not match claim');
		return confirmed;
	} catch {
		try { await finishFailed(row, user, db, stage, uncertain); }
		catch { return needsCheck(id); }
		return uncertain ? needsCheck(id) : failureMessage;
	}
}

export async function completeDeletion(id: string, action: DeleteAction, user: UserForum, token: string, env: Env) {
	let content: string | null;
	try { content = await deleteApplication(id, action, user, env); }
	catch { content = needsCheck(id); }
	if (content !== null) await editPrivateReply(content, token, env, 'delete');
}
