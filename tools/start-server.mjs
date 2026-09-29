// Foreground companion startup with the same private bootstrap identity as
// the browser launcher. Never print or persist it outside runtime/.
import { fileURLToPath } from 'node:url';
import { ensureCompanionAuthToken } from './server-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
process.env.CAPTAIN_COMPANION_TOKEN = await ensureCompanionAuthToken(root);
await import('../server/index.mjs');
