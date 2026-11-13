import type { UserForum } from './authorization';
import { isDiscordId, isRecord, type ApplicationInput } from './apply-form';

import { discordRequest, editPrivateReply, noMentions } from './discord';
import { applicationEmbed, applicationTitle } from './application-embed';

class UserFacingError extends Error {}

function postLink(env: Env, threadId: string) {
	return `https://discord.com/channels/${env.DISCORD_GUILD_ID}/${threadId}`;
}

/** Claim a modal once before external writes. The existing primary key is the deduplication key. */
export async function saveApplication(input: ApplicationInput, user: UserForum, env: Env): Promise<string> {
	const db = env.disc_tracker_db;
	const appliedAt = new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
	}).format(new Date());
	try {
		const inserted = await db.prepare(`
			INSERT INTO applications (id, owner_discord_id, forum_channel_id, company, position, job_url, notes, applied_at)
			SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
				SELECT 1 FROM application_deletions WHERE application_id = ? AND state = 'complete'
			) ON CONFLICT(id) DO NOTHING
		`).bind(input.id, user.ownerDiscordId, user.forumChannelId, input.company, input.position, input.jobUrl, input.notes, appliedAt, input.id).run();
		if (inserted.meta.changes === 0) {
			const existing = await db.prepare('SELECT discord_thread_id, status FROM applications WHERE id = ? AND owner_discord_id = ?')
				.bind(input.id, user.ownerDiscordId).first<{ discord_thread_id: string | null; status: string }>();
			if (existing?.discord_thread_id) return `This application is already saved — ${existing.status}. ${postLink(env, existing.discord_thread_id)}`;
			const removed = await db.prepare(`SELECT id FROM application_deletions
				WHERE application_id = ? AND owner_discord_id = ? AND state = 'complete' LIMIT 1`)
				.bind(input.id, user.ownerDiscordId).first();
			if (removed) return 'This application was deleted. Use /apply to start a new application.';
			return `This application is still processing or needs checking. Do not submit again until checked. Reference: ${input.id}.`;
		}
	} catch {
		return 'Database could not save the application. Check the D1 setup, then try again.';
	}

	let creationAttempted = false;
	let threadId: string | null = null;
	try {
		const channelResponse = await discordRequest(`/channels/${user.forumChannelId}`, env.DISCORD_TOKEN);
		if (!channelResponse.ok) throw new UserFacingError(`Could not read your Forum (HTTP ${channelResponse.status}). Check bot access, then try again.`);
		const channel: unknown = await channelResponse.json();
		if (!isRecord(channel) || channel.id !== user.forumChannelId || channel.type !== 15 || channel.guild_id !== env.DISCORD_GUILD_ID) {
			throw new UserFacingError('Your configured channel is not a Forum in this server. Check the Forum mapping, then try again.');
		}
		const tags = Array.isArray(channel.available_tags) ? channel.available_tags.filter((tag) => isRecord(tag) && tag.name === 'Applied' && isDiscordId(tag.id)) : [];
		if (tags.length !== 1) throw new UserFacingError('Your Forum needs exactly one tag named Applied. Add or correct that tag, then try again.');

		creationAttempted = true;
		const created = await discordRequest(`/channels/${user.forumChannelId}/threads`, env.DISCORD_TOKEN, 'POST', {
			name: applicationTitle(input), applied_tags: [tags[0].id],
			message: { allowed_mentions: noMentions, embeds: [applicationEmbed(input, appliedAt)] },
		});
		if (!created.ok) {
			// A server/network failure may have happened after Discord created the post.
			if (created.status >= 400 && created.status < 500) creationAttempted = false;
			throw new UserFacingError(created.status === 429
				? 'Discord is rate limiting requests. Wait a moment, then try again.'
				: `Discord could not create the Forum post (HTTP ${created.status}). Check bot permissions and tags, then try again.`);
		}
		const thread: unknown = await created.json();
		if (!isRecord(thread) || !isDiscordId(thread.id)) throw new Error('Unexpected thread response');
		threadId = thread.id;
		const linked = await db.prepare(`UPDATE applications SET discord_thread_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			WHERE id = ? AND owner_discord_id = ? AND discord_thread_id IS NULL`).bind(threadId, input.id, user.ownerDiscordId).run();
		if (linked.meta.changes !== 1) throw new Error('Application could not be linked');
		return `Application saved — Applied. ${postLink(env, threadId)}`;
	} catch (error) {
		if (threadId) return `Your Forum post was created, but its database link could not be saved. Do not submit again. ${postLink(env, threadId)} Reference: ${input.id}.`;
		if (creationAttempted) return `Discord's result could not be confirmed. Check your Forum. Do not submit again until checked. Reference: ${input.id}.`;
		try {
			await db.prepare('DELETE FROM applications WHERE id = ? AND owner_discord_id = ? AND discord_thread_id IS NULL')
				.bind(input.id, user.ownerDiscordId).run();
		} catch {
			return `The application could not be posted and its pending record needs checking. Do not submit again until checked. Reference: ${input.id}.`;
		}
		return error instanceof UserFacingError ? error.message : 'Could not read your Forum. Check bot access and try again.';
	}
}

/** Complete the deferred ephemeral response without storing or logging its token. */
export async function completeApplication(input: ApplicationInput, user: UserForum, interactionToken: string, env: Env): Promise<void> {
	let content: string;
	try {
		content = await saveApplication(input, user, env);
	} catch {
		content = 'The application could not be completed. Check your Forum before trying again.';
	}
	await editPrivateReply(content, interactionToken, env, 'apply');
}
