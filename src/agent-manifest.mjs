import { createHash } from 'node:crypto';

const TOP_LEVEL_FIELDS = new Set([
  'schema_version', 'agent_id', 'display_name', 'runtime', 'operator_entity_ref',
  'ki_agent_identity_ref', 'near_hub_contract', 'policy_hash',
  'capability_manifest_hash', 'chain_instances', 'status',
]);
const INSTANCE_FIELDS = new Set([
  'namespace', 'chain_id', 'instance_ref', 'token_ref', 'role',
]);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectUnknownFields(record, allowed, prefix, issues) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) issues.push(`unknown field: ${prefix}${key}`);
  }
}

/** Validate a proposed public AgentManifest; this does not bind or register it on-chain. */
export function validateAgentManifest(input) {
  if (!isRecord(input)) return ['manifest must be an object'];
  const issues = [];
  collectUnknownFields(input, TOP_LEVEL_FIELDS, '', issues);

  if (input.schema_version !== '1.0') issues.push('schema_version must be 1.0');
  if (typeof input.agent_id !== 'string' || !UUID_PATTERN.test(input.agent_id)) {
    issues.push('agent_id must be a UUID');
  }
  for (const field of [
    'display_name', 'runtime', 'operator_entity_ref', 'ki_agent_identity_ref',
    'near_hub_contract', 'status',
  ]) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') {
      issues.push(`${field} must be a non-empty string`);
    }
  }
  for (const field of ['policy_hash', 'capability_manifest_hash']) {
    if (typeof input[field] !== 'string' || !SHA256_PATTERN.test(input[field])) {
      issues.push(`${field} must use sha256:<64 lowercase hex characters>`);
    }
  }

  if (!Array.isArray(input.chain_instances) || input.chain_instances.length === 0) {
    issues.push('chain_instances must be a non-empty array');
  } else {
    const seen = new Set();
    input.chain_instances.forEach((instance, index) => {
      const prefix = `chain_instances[${index}].`;
      if (!isRecord(instance)) {
        issues.push(`${prefix.slice(0, -1)} must be an object`);
        return;
      }
      collectUnknownFields(instance, INSTANCE_FIELDS, prefix, issues);
      for (const field of ['namespace', 'chain_id', 'instance_ref', 'role']) {
        if (typeof instance[field] !== 'string' || instance[field].trim() === '') {
          issues.push(`${prefix}${field} must be a non-empty string`);
        }
      }
      if (instance.token_ref !== undefined &&
          (typeof instance.token_ref !== 'string' || instance.token_ref.trim() === '')) {
        issues.push(`${prefix}token_ref must be a non-empty string when provided`);
      }
      if (['namespace', 'chain_id', 'instance_ref'].every((key) =>
        typeof instance[key] === 'string' && instance[key].trim() !== '')) {
        const identity = JSON.stringify([instance.namespace, instance.chain_id, instance.instance_ref]);
        if (seen.has(identity)) issues.push(`${prefix}duplicate chain instance identity`);
        seen.add(identity);
      }
    });
  }
  return issues;
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObjectKeys(value[key])]));
  }
  return value;
}

/** Return deterministic JSON with recursively sorted object keys and preserved array order. */
export function canonicalManifestJson(manifest) {
  return JSON.stringify(sortObjectKeys(manifest));
}

/** Return a content hash for the canonical JSON; this does not sign or publish the manifest. */
export function manifestSha256(manifest) {
  const digest = createHash('sha256').update(canonicalManifestJson(manifest), 'utf8').digest('hex');
  return `sha256:${digest}`;
}
