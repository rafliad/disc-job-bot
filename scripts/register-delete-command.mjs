import { registerCommand } from './register-command.mjs';

await registerCommand('delete', 'Permanently delete one of your job applications.', [
	{ type: 3, name: 'application', description: 'Your job application', required: true, autocomplete: true },
]);
