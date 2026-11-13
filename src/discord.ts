import { isRecord } from './apply-form';

export const noMentions = { parse: [] };
export async function discordRequest(path: string, token: string | null, method = 'GET', body?: unknown, timeoutMs = 5000): Promise<Response> {
	return fetch(`https://discord.com/api/v10${path}`, {
		method, headers: { ...(token ? { Authorization: `Bot ${token}` } : {}), 'Content-Type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		// workerd rejects 'error'; manual never forwards credentials through redirects.
		redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
	});
}

export async function editPrivateReply(content: string, interactionToken: string, env: Env, command: 'apply' | 'status' | 'edit' | 'delete', timeoutMs = 5000): Promise<void> {
	const failureMessage = `${command}: private reply delivery failed; check the Forum and database before resubmitting.`;
	try {
		const response = await discordRequest(`/webhooks/${env.DISCORD_APPLICATION_ID}/${encodeURIComponent(interactionToken)}/messages/@original`, null, 'PATCH', {
			content, allowed_mentions: noMentions, ...(command === 'delete' ? { components: [] } : {}),
		}, timeoutMs);
		if (!response.ok) {
			let discordCode: number | null = null;
			try {
				const body: unknown = await response.json();
				if (isRecord(body) && typeof body.code === 'number' && Number.isSafeInteger(body.code) && body.code >= 0) discordCode = body.code;
			} catch { /* Never log raw bodies, including proxy HTML. */ }
			console.error(failureMessage, { operation: 'reply_edit', failure: 'http', http_status: response.status, discord_code: discordCode });
		}
	} catch (error) {
		const failure = isRecord(error) && error.name === 'TimeoutError' ? 'timeout'
			: isRecord(error) && error.name === 'AbortError' ? 'aborted' : 'network_or_runtime';
		console.error(failureMessage, { operation: 'reply_edit', failure });
	}
}
