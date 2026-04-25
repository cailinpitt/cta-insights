#!/usr/bin/env node
// Idempotent — re-following on AtProto is a no-op. Run after creating a new
// bot account or whenever the follow graph drifts.

require('../src/shared/env');
const argv = require('minimist')(process.argv.slice(2), { boolean: ['dry-run'] });
const { login } = require('../src/shared/bluesky');

const ACCOUNTS = [
  {
    label: 'bus',
    identifier: process.env.BLUESKY_BUS_IDENTIFIER,
    password: process.env.BLUESKY_BUS_APP_PASSWORD,
  },
  {
    label: 'train',
    identifier: process.env.BLUESKY_TRAIN_IDENTIFIER,
    password: process.env.BLUESKY_TRAIN_APP_PASSWORD,
  },
  {
    label: 'alerts',
    identifier: process.env.BLUESKY_ALERTS_IDENTIFIER,
    password: process.env.BLUESKY_ALERTS_APP_PASSWORD,
  },
];

async function resolveDids(agent, handles) {
  const out = new Map();
  for (const handle of handles) {
    try {
      const { data } = await agent.com.atproto.identity.resolveHandle({ handle });
      out.set(handle, data.did);
    } catch (e) {
      console.warn(`  could not resolve ${handle}: ${e.message}`);
    }
  }
  return out;
}

async function followFromAccount(account, others) {
  if (!account.identifier || !account.password) {
    console.warn(`[${account.label}] no credentials in env, skipping`);
    return;
  }
  console.log(`\n[${account.label}] logging in as ${account.identifier}...`);
  const agent = await login(account.identifier, account.password);

  const targetHandles = others.map((o) => o.identifier).filter(Boolean);
  const didByHandle = await resolveDids(agent, targetHandles);

  for (const target of others) {
    if (!target.identifier) continue;
    const did = didByHandle.get(target.identifier);
    if (!did) {
      console.warn(`  no DID for ${target.identifier}, skipping`);
      continue;
    }
    if (argv['dry-run']) {
      console.log(`  [dry-run] would follow ${target.identifier} (${did})`);
      continue;
    }
    try {
      await agent.follow(did);
      console.log(`  followed ${target.identifier}`);
    } catch (e) {
      console.warn(`  follow ${target.identifier} failed: ${e.message}`);
    }
  }
}

async function main() {
  for (const account of ACCOUNTS) {
    const others = ACCOUNTS.filter((a) => a.label !== account.label);
    try {
      await followFromAccount(account, others);
    } catch (e) {
      console.error(`[${account.label}] failed: ${e.stack || e.message}`);
    }
  }
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
