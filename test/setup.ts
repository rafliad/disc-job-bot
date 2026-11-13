import { applyD1Migrations, env, type D1Migration } from 'cloudflare:test';
import { beforeEach, inject } from 'vitest';

declare module 'vitest' {
	interface ProvidedContext {
		migrations: D1Migration[];
	}
}

// Only the isolated test database is touched, never the remote D1 database.
beforeEach(async () => {
	await applyD1Migrations(env.disc_tracker_db, inject('migrations'));
	await env.disc_tracker_db.batch([
		env.disc_tracker_db.prepare('DELETE FROM application_deletions'),
		env.disc_tracker_db.prepare('DELETE FROM applications'),
	]);
});
