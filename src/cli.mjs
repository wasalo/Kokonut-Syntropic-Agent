#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { validateAgentManifest, manifestSha256 } from './agent-manifest.mjs';
import { validateNearlyLaunchConfig } from './nearly-launch-config.mjs';
import { previewNearlyTaxAllocation } from './nearly-economics-preview.mjs';
import { evaluateNearlyFactorySnapshot, readNearlyFactorySnapshot } from './nearly-readiness.mjs';
import { readNearlyEconomicsSnapshot } from './nearly-economics-observer.mjs';
import { indexNearLakeBlock, indexNearLakeMessages } from './near-event-indexer.mjs';

const USAGE = [
  'Usage:',
  '  syntropic-agent manifest <config.json>',
  '  syntropic-agent nearly <config.json>',
  '  syntropic-agent preview <taxableAmountUnits>',
  '  syntropic-agent near-readiness',
  '  syntropic-agent near-economics <launchId>',
  '  syntropic-agent near-events <block-message.json> [accountId ...]',
].join('\n');

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

const [command, arg, ...extraArgs] = process.argv.slice(2);
if (command === 'near-events') {
  if (!arg) {
    fail(USAGE, 2);
  } else {
    try {
      const message = JSON.parse(readFileSync(arg, 'utf8'));
      const indexed = Array.isArray(message)
        ? indexNearLakeMessages(message, { accountFilter: extraArgs })
        : indexNearLakeBlock(message, { accountFilter: extraArgs });
      process.stdout.write(`${JSON.stringify(indexed, null, 2)}\n`);
    } catch (error) {
      if (error instanceof SyntaxError) {
        fail(`invalid JSON: ${error.message}`);
      } else if (error?.code === 'ENOENT') {
        fail(`cannot read input file: ${arg}`);
      } else {
        fail(`NEAR event indexing failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
} else if (command === 'near-economics') {
  if (!arg || extraArgs.length > 0) {
    fail(USAGE, 2);
  } else {
    try {
      const snapshot = await readNearlyEconomicsSnapshot(arg);
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    } catch (error) {
      fail(`Nearly economics observation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} else if (command === 'near-readiness') {
  if (arg || extraArgs.length > 0) {
    fail(USAGE, 2);
  } else {
    try {
      const snapshot = await readNearlyFactorySnapshot();
      const report = evaluateNearlyFactorySnapshot(snapshot);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.status === 'blocked') process.exitCode = 1;
    } catch (error) {
      fail(`Nearly readiness check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} else if (command === 'preview') {
  if (!arg || extraArgs.length > 0) {
    fail(USAGE, 2);
  } else {
    try {
      const preview = previewNearlyTaxAllocation(arg);
      process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
      process.stderr.write(
        'Illustrative math only: no contract rounding, live fees, fee-swap proceeds, or NEAR/USD value is verified.\n',
      );
    } catch (error) {
      fail(`invalid preview input: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} else if (!['manifest', 'nearly'].includes(command) || !arg || extraArgs.length > 0) {
  fail(USAGE, 2);
} else {
  try {
    const input = JSON.parse(readFileSync(arg, 'utf8'));
    const issues = command === 'manifest'
      ? validateAgentManifest(input)
      : validateNearlyLaunchConfig(input);

    if (issues.length > 0) {
      fail(issues.map((issue) => `- ${issue}`).join('\n'));
    } else if (command === 'manifest') {
      process.stdout.write(`Valid AgentManifest\n${manifestSha256(input)}\n`);
    } else {
      process.stdout.write(
        'Configuration matches the local contract-aligned model only; this does not verify live contract state or authorize launch.\n',
      );
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(`invalid JSON: ${error.message}`);
    } else if (error?.code === 'ENOENT') {
      fail(`cannot read input file: ${arg}`);
    } else {
      fail(`validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
