import { parseEnv } from 'node:util';

export function configuredOllama(env, envText = '') {
  const value = env.CAPTAIN_OLLAMA_MODEL ?? parseEnv(envText).CAPTAIN_OLLAMA_MODEL;
  return typeof value === 'string' && value.trim().length > 0;
}

export async function ensureOptionalOllama({ enabled, fetchService = fetch, spawnService }) {
  if (!enabled) return { enabled: false, started: false };
  try {
    const response = await fetchService('http://127.0.0.1:11434/api/tags', {signal: AbortSignal.timeout(2000)});
    if (response.ok) return { enabled: true, started: false };
  } catch { /* Explicitly configured local service may need starting. */ }
  await spawnService();
  return { enabled: true, started: true };
}
