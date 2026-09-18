/**
 * Prepare provider-specific noninteractive calls behind the Workshop response contract.
 * Usage: const invocation = await prepareAgentInvocation(profile, '/project/tmp/job');
 * The parent dispatcher validates the final stdout against its retained failure packet.
 */
const fs = require('node:fs/promises');
const path = require('node:path');

const explanationSchema = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'string', enum: ['workshop-explanation.v1'] },
    packetId: { type: 'string' }, failureId: { type: 'string' }, sourceHash: { type: 'string' },
    verdict: { type: 'string', enum: ['explained', 'uncertain', 'needs-human'] },
    summary: { type: 'string' }, evidenceIds: { type: 'array', items: { type: 'string' } },
    suggestions: { type: 'array', items: { type: 'object', properties: {
      text: { type: 'string' }, evidenceIds: { type: 'array', items: { type: 'string' } },
    }, required: ['text', 'evidenceIds'], additionalProperties: false } },
  },
  required: ['schemaVersion', 'packetId', 'failureId', 'sourceHash', 'verdict', 'summary', 'evidenceIds', 'suggestions'],
  additionalProperties: false,
};

/** Materialize only Codex's output schema in the owned scratch job and fix its invocation policy. */
async function prepareAgentInvocation(profile, cwd) {
  if (profile.adapter === 'custom') return profile;
  if (profile.adapter !== 'codex') throw Object.assign(new Error('Unsupported agent adapter.'), { code: 'AGENT_PROFILE_INVALID' });
  const schemaPath = path.join(cwd, 'response-schema.json');
  await fs.writeFile(schemaPath, JSON.stringify(explanationSchema) + '\n', { flag: 'wx', mode: 0o600 });
  return { ...profile, args: [
    '-a', 'never', 'exec', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config',
    '--skip-git-repo-check', '--output-schema', schemaPath, '-',
  ] };
}

module.exports = { prepareAgentInvocation };
