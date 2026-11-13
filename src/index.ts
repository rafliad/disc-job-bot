import { resolveUserForum } from './authorization';
import { applyModal, isDiscordId, isRecord, parseApplication } from './apply-form';
import { completeApplication } from './applications';
import { autocompleteApplications, emptyAutocomplete, parseStatusOptions } from './status-form';
import { completeStatus } from './status';
import { parseEdit, parseEditOptions } from './edit-form';
import { completeEdit, openEdit } from './edits';
import { completeDeletion, openDelete, parseDeleteButton } from './deletions';

function privateReply(content: string): Response {
	return Response.json({ type: 4, data: { content, flags: 64 } });
}

/** Decode fixed-size hexadecimal keys/signatures without accepting partial values. */
function decodeHex(value: string | null | undefined, byteLength: number): Uint8Array<ArrayBuffer> | null {
	if (!value || value.length !== byteLength * 2 || !/^[0-9a-f]+$/i.test(value)) {
		return null;
	}

	const bytes = new Uint8Array(byteLength);
	for (let index = 0; index < byteLength; index++) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (new URL(request.url).pathname !== '/') {
			return new Response('Not found', { status: 404 });
		}
		if (request.method === 'GET') {
			return new Response('Job Tracker is running!');
		}
		if (request.method !== 'POST') {
			return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
		}

		const signature = decodeHex(request.headers.get('X-Signature-Ed25519'), 64);
		const timestamp = request.headers.get('X-Signature-Timestamp');
		if (!signature || !timestamp) {
			return new Response('Invalid request signature', { status: 401 });
		}

		const publicKeyBytes = decodeHex(env.DISCORD_PUBLIC_KEY, 32);
		if (!publicKeyBytes) {
			return new Response('Discord public key is not configured correctly', { status: 500 });
		}

		// Discord signs the timestamp followed by the original body bytes.
		// Verify these bytes before parsing JSON or otherwise changing the body.
		const rawBody = await request.arrayBuffer();
		const timestampBytes = new TextEncoder().encode(timestamp);
		const signedMessage = new Uint8Array(timestampBytes.length + rawBody.byteLength);
		signedMessage.set(timestampBytes);
		signedMessage.set(new Uint8Array(rawBody), timestampBytes.length);

		try {
			const publicKey = await crypto.subtle.importKey('raw', publicKeyBytes, 'Ed25519', false, ['verify']);
			const verified = await crypto.subtle.verify('Ed25519', publicKey, signature, signedMessage);
			if (!verified) {
				return new Response('Invalid request signature', { status: 401 });
			}
		} catch {
			// Do not include request payloads, interaction tokens, or credentials in logs.
			return new Response('Unable to verify the Discord request', { status: 500 });
		}

		let interaction: unknown;
		try {
			interaction = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(rawBody));
		} catch {
			return new Response('Invalid JSON', { status: 400 });
		}

		if (typeof interaction !== 'object' || interaction === null || !('type' in interaction) || typeof interaction.type !== 'number') {
			return new Response('Invalid interaction payload', { status: 400 });
		}
		if (interaction.type === 1) {
			return Response.json({ type: 1 });
		}
		const data = 'data' in interaction ? interaction.data : null;
		const isDeleteCommand = interaction.type === 2 && isRecord(data) && data.type === 1 && data.name === 'delete';
		const isDeleteButton = interaction.type === 3 && isRecord(data) && typeof data.custom_id === 'string' && data.custom_id.startsWith('delete:');
		if (isDeleteCommand || isDeleteButton) {
			const user = resolveUserForum(interaction, env);
			if (!user) return privateReply('You do not have access to this tracker in this server.');
			if (!('application_id' in interaction) || interaction.application_id !== env.DISCORD_APPLICATION_ID ||
				!('id' in interaction) || !isDiscordId(interaction.id)) return privateReply('Invalid delete request. Run /delete again.');
			if (isDeleteCommand) {
				const app = parseEditOptions(data);
				return app ? openDelete(app, user, interaction.id, env) : privateReply('Select one of your saved applications to delete.');
			}
			const input = parseDeleteButton(data);
			if (!input || !('token' in interaction) || typeof interaction.token !== 'string' || !interaction.token || interaction.token.length > 512)
				return privateReply('Invalid delete confirmation. Run /delete again.');
			ctx.waitUntil(completeDeletion(input.promptId, input.action, user, interaction.token, env));
			return Response.json({ type: 6 });
		}
		const isEditCommand = interaction.type === 2 && isRecord(data) && data.type === 1 && data.name === 'edit';
		const isEditSubmit = interaction.type === 5 && isRecord(data) && typeof data.custom_id === 'string' && data.custom_id.startsWith('edit:');
		if (isEditCommand || isEditSubmit) {
			const user = resolveUserForum(interaction,env);
			if (!user) return privateReply('You do not have access to this tracker in this server.');
			if (!('application_id' in interaction) || interaction.application_id !== env.DISCORD_APPLICATION_ID ||
				!('id' in interaction) || !isDiscordId(interaction.id)) return privateReply('Invalid edit request. Run /edit again.');
			if (isEditCommand) {
				const app = parseEditOptions(data);
				return app ? openEdit(app,user,interaction.id,env) : privateReply('Invalid edit request. Select one of your saved applications.');
			}
			const parsed = parseEdit(data,user.ownerDiscordId);
			if ('error' in parsed) return privateReply(parsed.error);
			if (!('token' in interaction) || typeof interaction.token !== 'string' || !interaction.token || interaction.token.length > 512)
				return privateReply('Invalid edit request. Run /edit again.');
			ctx.waitUntil(completeEdit(parsed.value,user,interaction.token,env));
			return Response.json({type:5,data:{flags:64}});
		}
		if (interaction.type === 2 && isRecord(data) && data.type === 1 && data.name === 'status') {
			const user = resolveUserForum(interaction,env);
			if (!user) return privateReply('You do not have access to this tracker in this server.');
			const input = parseStatusOptions(data);
			if (!input || !('application_id' in interaction) || interaction.application_id !== env.DISCORD_APPLICATION_ID ||
				!('id' in interaction) || !isDiscordId(interaction.id) || !('token' in interaction) ||
				typeof interaction.token !== 'string' || !interaction.token || interaction.token.length > 512)
				return privateReply('Invalid status request. Select your application and one of the seven statuses.');
			ctx.waitUntil(completeStatus(input,user,interaction.id,interaction.token,env));
			return Response.json({type:5,data:{flags:64}});
		}
		if (interaction.type === 4 && isRecord(data) && data.type === 1 && (data.name === 'status' || data.name === 'edit' || data.name === 'delete')) {
			const user = resolveUserForum(interaction, env);
			if (!user || !('application_id' in interaction) || interaction.application_id !== env.DISCORD_APPLICATION_ID ||
				!('id' in interaction) || !isDiscordId(interaction.id)) return emptyAutocomplete();
			return autocompleteApplications(data, user, env, data.name);
		}
		const isApplyCommand = interaction.type === 2 && isRecord(data) && data.type === 1 && data.name === 'apply';
		const isApplySubmit = interaction.type === 5 && isRecord(data) && typeof data.custom_id === 'string' && data.custom_id.startsWith('apply:');
		if (isApplyCommand || isApplySubmit) {
			const user = resolveUserForum(interaction, env);
			if (!user) return privateReply('You do not have access to this tracker in this server.');
			if (!('application_id' in interaction) || interaction.application_id !== env.DISCORD_APPLICATION_ID ||
				!('id' in interaction) || !isDiscordId(interaction.id)) {
				return privateReply('Invalid application request. Run /apply again.');
			}
			if (isApplyCommand) return Response.json(applyModal(interaction.id, user.ownerDiscordId));
			const parsed = parseApplication(data, user.ownerDiscordId);
			if ('error' in parsed) return privateReply(parsed.error);
			if (!('token' in interaction) || typeof interaction.token !== 'string' || !interaction.token || interaction.token.length > 512) {
				return privateReply('Invalid application request. Run /apply again.');
			}
			// ACK immediately; D1 and Discord REST work continue after the response.
			ctx.waitUntil(completeApplication(parsed.value, user, interaction.token, env));
			return Response.json({ type: 5, data: { flags: 64 } });
		}
		if (interaction.type === 2 && 'guild_id' in interaction && typeof interaction.guild_id === 'string' && interaction.guild_id) {
			const command = 'data' in interaction ? interaction.data : null;
			if (
				typeof command === 'object' && command !== null &&
				'type' in command && command.type === 1 &&
				'name' in command && command.name === 'test'
			) {
				const userForum = resolveUserForum(interaction, env);
				if (!userForum) {
					return Response.json({
						type: 4,
						data: { content: 'You do not have access to this tracker in this server.', flags: 64 },
					});
				}
				try {
					// Check the binding and migrated table without reading application data.
					await env.disc_tracker_db.prepare('SELECT id FROM applications LIMIT 0').all();
				} catch {
					return Response.json({
						type: 4,
						data: { content: 'Database is not ready. Apply the D1 migration, then try /test again.', flags: 64 },
					});
				}
				return Response.json({
					type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
					data: {
						content: `Job Tracker is connected!\nDatabase is ready. Your Forum: <#${userForum.forumChannelId}>.`,
						flags: 64, // EPHEMERAL
					},
				});
			}
		}

		return new Response('Unsupported interaction type', { status: 400 });
	},
} satisfies ExportedHandler<Env>;
