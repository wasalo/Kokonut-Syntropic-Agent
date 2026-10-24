import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalManifestJson, manifestSha256, validateAgentManifest } from '../src/agent-manifest.mjs';

const manifest = {
  schema_version: '1.0',
  agent_id: '9ddfc9c8-c871-4c12-b0a6-70e86bc8cc89',
  display_name: 'Kokonut Syntropic Agent',
  runtime: 'Hermes',
  operator_entity_ref: '<pending-approved-entity-reference>',
  ki_agent_identity_ref: '<deferred-until-ki-refactor>',
  near_hub_contract: '<pending-protocol-approval>',
  policy_hash: `sha256:${'a'.repeat(64)}`,
  capability_manifest_hash: `sha256:${'b'.repeat(64)}`,
  chain_instances: [
    {
      namespace: 'eip155',
      chain_id: '8453',
      instance_ref: 'virtuals-base',
      token_ref: '<verify-base-token-contract>',
      role: 'commerce',
    },
    {
      namespace: 'near',
      chain_id: 'mainnet',
      instance_ref: 'near-hub',
      token_ref: '<pending-nep-141-account>',
      role: 'orchestration',
    },
  ],
  status: 'active',
};

test('accepts the PRD-shaped manifest while preserving unresolved external references', () => {
  assert.deepEqual(validateAgentManifest(manifest), []);
});

test('rejects malformed canonical IDs and hashes', () => {
  const invalid = structuredClone(manifest);
  invalid.agent_id = 'not-a-uuid';
  invalid.policy_hash = '0x1234';
  const issues = validateAgentManifest(invalid);
  assert.ok(issues.some((issue) => issue.includes('agent_id')));
  assert.ok(issues.some((issue) => issue.includes('policy_hash')));
});

test('requires chain identifiers to remain strings and chain-qualified', () => {
  const invalid = structuredClone(manifest);
  invalid.chain_instances[0].chain_id = 8453;
  const issues = validateAgentManifest(invalid);
  assert.ok(issues.some((issue) => issue.includes('chain_id')));
});

test('rejects duplicate chain instance identities', () => {
  const invalid = structuredClone(manifest);
  invalid.chain_instances.push(structuredClone(invalid.chain_instances[0]));
  assert.ok(validateAgentManifest(invalid).some((issue) => issue.includes('duplicate')));
});

test('canonical JSON and digest are stable regardless of object key order', () => {
  const reordered = Object.fromEntries(Object.entries(manifest).reverse());
  assert.equal(canonicalManifestJson(manifest), canonicalManifestJson(reordered));
  assert.equal(manifestSha256(manifest), manifestSha256(reordered));
  assert.match(manifestSha256(manifest), /^sha256:[a-f0-9]{64}$/);
});

test('manifest digest changes when a capability binding changes', () => {
  const changed = structuredClone(manifest);
  changed.capability_manifest_hash = `sha256:${'c'.repeat(64)}`;
  assert.notEqual(manifestSha256(manifest), manifestSha256(changed));
});
