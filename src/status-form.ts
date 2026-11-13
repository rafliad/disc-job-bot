import { isDiscordId, isRecord } from './apply-form';
import type { UserForum } from './authorization';

export const statuses = ['Applied', 'Screening', 'Assessment', 'Interview', 'Offer', 'Rejected', 'Withdrawn'] as const;
export type ApplicationStatus = typeof statuses[number];
export function isStatus(value: unknown): value is ApplicationStatus {
	return typeof value === 'string' && (statuses as readonly string[]).includes(value);
}
export function emptyAutocomplete(): Response { return Response.json({ type: 8, data: { choices: [] } }); }

export interface StatusInput { applicationId: string; status: ApplicationStatus }
export function parseStatusOptions(data: unknown): StatusInput | null {
	if (!isRecord(data) || !Array.isArray(data.options) || data.options.length !== 2) return null;
	const values = new Map<string, unknown>();
	for (const option of data.options) {
		if (!isRecord(option) || option.type !== 3 || typeof option.name !== 'string' ||
			!['application','status'].includes(option.name) || values.has(option.name) || option.focused === true) return null;
		values.set(option.name, option.value);
	}
	const applicationId = values.get('application');
	const status = values.get('status');
	return isDiscordId(applicationId) && isStatus(status) ? { applicationId, status } : null;
}

export async function autocompleteApplications(data: unknown, user: UserForum, env: Env, command: 'status' | 'edit' | 'delete' = 'status'): Promise<Response> {
	const allowed = command === 'status' ? ['application','status'] : ['application'];
	if (!isRecord(data) || !Array.isArray(data.options) || data.options.length > allowed.length) return emptyAutocomplete();
	const seen = new Set<string>();
	let query: string | null = null;
	for (const option of data.options) {
		if (!isRecord(option) || option.type !== 3 || typeof option.name !== 'string' ||
			!allowed.includes(option.name) || seen.has(option.name) || typeof option.value !== 'string') return emptyAutocomplete();
		seen.add(option.name);
		if (option.focused === true) {
			if (option.name !== 'application' || option.value.length > 100) return emptyAutocomplete();
			query = option.value.trim();
		}
	}
	if (query === null) return emptyAutocomplete();
	try {
		const { results } = await env.disc_tracker_db.prepare(`SELECT id, company, position, status, applied_at FROM applications
			WHERE owner_discord_id = ? AND forum_channel_id = ? AND discord_thread_id IS NOT NULL AND status_change_id IS NULL
			AND instr(lower(company || ' ' || position), lower(?)) > 0 ORDER BY updated_at DESC, id DESC LIMIT 25`)
			.bind(user.ownerDiscordId, user.forumChannelId, query).all<{ id: string; company: string; position: string; status: string; applied_at: string }>();
		const choices = results.map((row) => {
			const suffix = ` [${row.status}] · ${row.applied_at} · ${row.id.slice(-6)}`;
			let title = '';
			for (const character of `${row.company} — ${row.position}`) {
				if (title.length + character.length + suffix.length > 100) break;
				title += character;
			}
			return { name: title + suffix, value: row.id };
		});
		return Response.json({ type: 8, data: { choices } });
	} catch { return emptyAutocomplete(); }
}
