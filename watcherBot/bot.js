/**
 * GHOST Protocol — Executor Bot
 *
 * Watches all ghost accounts on-chain. When a grace period has expired
 * and execution hasn't happened yet, this bot submits the execute_transfer
 * transaction automatically.
 *
 * Deploy on Railway: push to GitHub → connect repo → set env vars → done.
 *
 * ── v1.8 update notes ────────────────────────────────────────────────────────
 * GhostAccount layout changed significantly across versions:
 *
 *   v1.6 (old)  : 153 bytes data  (single Option<Pubkey> recovery_wallet)
 *   v1.7        : 1220 bytes data (recovery_wallet → [Option<Pubkey>;3],
 *                                  beneficiaries[10], display_name, image_uri)
 *   v1.8        : 1221 bytes data (+ schema_version: u8 appended at end)
 *
 * Key fixes vs old bot:
 *   - dataSize filter was 153 (v1.6 only) → now fetches both 1228 (v1.7) and 1229 (v1.8)
 *   - recovery_wallet was parsed as single Option<Pubkey> → now [Option<Pubkey>;3] (3 slots)
 *   - awakened_at/executed_at were always read as 9 bytes → now Borsh-correct (None=1b, Some=9b)
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} = require('@solana/web3.js');
const bs58 = require('bs58');

// ─── Config ───────────────────────────────────────────────────────────────────

const RPC_URL         = process.env.RPC_URL    || 'https://api.mainnet-beta.solana.com';
const PROGRAM_ID      = process.env.PROGRAM_ID || '69CthivgcVfvMbEJLtUcpbnztNzJ26VCfjAwMj5jdMnZ';
const BOT_KEYPAIR_B58 = process.env.BOT_KEYPAIR;

const POLL_INTERVAL_MS        = 5 * 60 * 1000;
const EXECUTION_BUFFER_SECONDS = 60;

const DISC = {
  awaken_ghost:     Buffer.from([184,  91,  42, 182, 145,  78, 199,  65]),
  execute_transfer: Buffer.from([233, 126, 160, 184, 235, 206,  31, 119]),
};

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// getProgramAccounts dataSize includes the 8-byte Anchor discriminator
const ACCOUNT_SIZE_V17 = 1228; // 8 disc + 1220 data
const ACCOUNT_SIZE_V18 = 1229; // 8 disc + 1221 data (+ schema_version byte)

// ─── Setup ────────────────────────────────────────────────────────────────────

if (!BOT_KEYPAIR_B58) {
  console.error('❌ BOT_KEYPAIR env var not set. Add your bot wallet private key (base58) in Railway.');
  process.exit(1);
}

const botKeypair  = Keypair.fromSecretKey(bs58.decode(BOT_KEYPAIR_B58));
const connection  = new Connection(RPC_URL, 'confirmed');
const programIdPk = new PublicKey(PROGRAM_ID);

console.log('👻 GHOST Executor Bot starting...');
console.log('   Program:', PROGRAM_ID);
console.log('   Bot wallet:', botKeypair.publicKey.toBase58());
console.log('   RPC:', RPC_URL);
console.log('   Polling every', POLL_INTERVAL_MS / 60000, 'minutes');
console.log('   Watching account sizes:', ACCOUNT_SIZE_V17, '(v1.7) and', ACCOUNT_SIZE_V18, '(v1.8)\n');

// ─── Account Layout Parser ─────────────────────────────────────────────────────
//
// GhostAccount Borsh layout (v1.7 / v1.8):
//
//   disc(8) + owner(32)
//   + recovery_wallets([Option<Pubkey>;3])  — 3 slots: None=1b, Some=1b+32b
//   + last_heartbeat(i64=8)
//   + interval_seconds(i64=8)
//   + grace_period_seconds(i64=8)
//   + awakened(bool=1)
//   + awakened_at(Option<i64>)              — None=1b, Some=9b
//   + executed(bool=1)
//   + executed_at(Option<i64>)              — None=1b, Some=9b
//   + staked_ghost(u64=8)
//   + bump(u8=1) + vault_bump(u8=1)
//   + registered_at(i64=8)
//   + ping_count(u64=8)
//   + beneficiary_count(u8=1)
//   + ... (beneficiaries, whole_vault fields, display_name, image_uri — not parsed by bot)
//   + schema_version(u8=1)                  — v1.8 only, at data byte 1220

function parseGhostAccount(pubkey, data) {
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let o = 8; // skip 8-byte Anchor discriminator

    // owner: Pubkey (32)
    const owner = new PublicKey(data.slice(o, o + 32)).toBase58();
    o += 32;

    // recovery_wallets: [Option<Pubkey>; 3]
    // Fixed-length Borsh array — no length prefix. Each: None=1b tag, Some=1b+32b.
    for (let i = 0; i < 3; i++) {
      const tag = data[o]; o += 1;
      if (tag === 1) o += 32;
    }

    // last_heartbeat: i64 (Unix seconds)
    const lastHeartbeat = Number(view.getBigInt64(o, true)); o += 8;

    // interval_seconds: i64
    const intervalSeconds = Number(view.getBigInt64(o, true)); o += 8;

    // grace_period_seconds: i64
    const gracePeriodSeconds = Number(view.getBigInt64(o, true)); o += 8;

    // awakened: bool
    const awakened = data[o] === 1; o += 1;

    // awakened_at: Option<i64> — Borsh None=1b, Some=1b tag + 8b value
    const hasAwakenedAt = data[o] === 1; o += 1;
    const awakenedAt = hasAwakenedAt ? Number(view.getBigInt64(o, true)) : null;
    if (hasAwakenedAt) o += 8;

    // executed: bool
    const executed = data[o] === 1; o += 1;

    // executed_at: Option<i64> — Borsh None=1b, Some=9b (skip — bot doesn't need it)
    const exTag = data[o]; o += 1;
    if (exTag === 1) o += 8;

    // staked_ghost: u64
    const stakedGhost = Number(view.getBigUint64(o, true)); o += 8;

    // bump: u8, vault_bump: u8
    o += 2;

    // registered_at: i64 (skip)
    o += 8;

    // ping_count: u64
    const pingCount = Number(view.getBigUint64(o, true)); o += 8;

    // beneficiary_count: u8
    const beneficiaryCount = data[o]; o += 1;

    // Sanity checks — catches misaligned parsing or corrupted accounts
    const validInterval   = intervalSeconds >= 3600 && intervalSeconds <= 315360000;
    const validBeneCount  = beneficiaryCount <= 10;
    const validHeartbeat  = lastHeartbeat > 1600000000 && lastHeartbeat < 2000000000;

    if (!validInterval || !validBeneCount || !validHeartbeat) {
      console.warn(`  ⚠️  ${pubkey.toBase58().slice(0,8)}... parse sanity failed — interval=${intervalSeconds} bene=${beneficiaryCount} hb=${lastHeartbeat} — skipping`);
      return null;
    }

    // schema_version — v1.8 appends this as last byte at data offset 1220
    const schemaVersion = data.length >= 1229 ? data[1228] : 17;

    return {
      pubkey: pubkey.toBase58(),
      owner,
      lastHeartbeat,
      intervalSeconds,
      gracePeriodSeconds,
      awakened,
      awakenedAt,
      executed,
      stakedGhost,
      pingCount,
      beneficiaryCount,
      schemaVersion,
    };
  } catch (err) {
    console.warn(`  ⚠️  Failed to parse ${pubkey.toBase58().slice(0,8)}...:`, err.message);
    return null;
  }
}

// ─── PDA Derivation ───────────────────────────────────────────────────────────

function deriveGhostPda(ownerPubkey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('ghost'), ownerPubkey.toBytes()],
    programIdPk
  );
}

function deriveVaultPda(ghostPda) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), ghostPda.toBytes()],
    programIdPk
  );
}

// ─── Awaken Ghost ─────────────────────────────────────────────────────────────

async function awakenGhost(ghost) {
  console.log(`  ⚡ Awakening ghost for ${ghost.owner.slice(0,8)}...`);
  const ownerPk    = new PublicKey(ghost.owner);
  const [ghostPda] = deriveGhostPda(ownerPk);

  const ix = new TransactionInstruction({
    programId: programIdPk,
    keys: [
      { pubkey: ghostPda,             isSigner: false, isWritable: true },
      { pubkey: botKeypair.publicKey, isSigner: true,  isWritable: true },
    ],
    data: DISC.awaken_ghost,
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: botKeypair.publicKey });
  tx.add(ix);
  tx.sign(botKeypair);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  console.log(`  ✅ Ghost awakened. Tx: ${sig}`);
  return sig;
}

// ─── Execute Transfer ─────────────────────────────────────────────────────────

async function executeTransfer(ghost, beneficiaryIndex) {
  const ownerPk    = new PublicKey(ghost.owner);
  const [ghostPda] = deriveGhostPda(ownerPk);
  const [vaultPda] = deriveVaultPda(ghostPda);

  const data = Buffer.alloc(9); // 8 disc + 1 u8 index
  DISC.execute_transfer.copy(data, 0);
  data.writeUInt8(beneficiaryIndex, 8);

  const ix = new TransactionInstruction({
    programId: programIdPk,
    keys: [
      { pubkey: ghostPda,             isSigner: false, isWritable: true  },
      { pubkey: vaultPda,             isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,     isSigner: false, isWritable: false },
      { pubkey: botKeypair.publicKey, isSigner: true,  isWritable: true  },
    ],
    data,
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: botKeypair.publicKey });
  tx.add(ix);
  tx.sign(botKeypair);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

// ─── Main Scan Loop ───────────────────────────────────────────────────────────

async function scanAndExecute() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  console.log(`\n🔍 Scanning ghost accounts... [${new Date().toISOString()}]`);

  let accounts = [];
  try {
    // Fetch v1.7 and v1.8 accounts in parallel — different dataSize filters
    const [v17, v18] = await Promise.all([
      connection.getProgramAccounts(programIdPk, {
        commitment: 'confirmed',
        filters: [{ dataSize: ACCOUNT_SIZE_V17 }],
      }),
      connection.getProgramAccounts(programIdPk, {
        commitment: 'confirmed',
        filters: [{ dataSize: ACCOUNT_SIZE_V18 }],
      }),
    ]);

    // Deduplicate by pubkey
    const seen = new Set();
    for (const acct of [...v17, ...v18]) {
      const key = acct.pubkey.toBase58();
      if (!seen.has(key)) { seen.add(key); accounts.push(acct); }
    }
    console.log(`  Found ${v17.length} v1.7 + ${v18.length} v1.8 = ${accounts.length} total account(s)`);
  } catch (err) {
    console.error('  ❌ RPC error fetching accounts:', err.message);
    return;
  }

  for (const { pubkey, account } of accounts) {
    const data  = new Uint8Array(account.data);
    const ghost = parseGhostAccount(pubkey, data);
    if (!ghost) continue;

    const heartbeatExpiry = ghost.lastHeartbeat + ghost.intervalSeconds;
    const graceExpiry     = ghost.awakenedAt != null
      ? ghost.awakenedAt + ghost.gracePeriodSeconds
      : null;

    // ── Skip un-migrated v1.7 accounts ──────────────────────────────────────
    // execute_transfer requires v1.8 struct layout (1221 bytes). v1.7 accounts
    // (1220 bytes) will fail deserialization on-chain. Only the owner can migrate
    // via the frontend — the bot cannot sign migrate_ghost on their behalf.
    if (ghost.schemaVersion < 18) {
      console.log(`  ⚠️  ${ghost.owner.slice(0,8)}... is v${ghost.schemaVersion} (un-migrated) — skipping, owner must migrate via frontend first`);
      continue;
    }

    // ── Case 1: Heartbeat expired, not yet awakened ───────────────────────────
    if (!ghost.awakened && !ghost.executed && nowSeconds > heartbeatExpiry + EXECUTION_BUFFER_SECONDS) {
      const overdueHours = Math.round((nowSeconds - heartbeatExpiry) / 3600);
      console.log(`  ⚠️  ${ghost.owner.slice(0,8)}... overdue by ${overdueHours}h — awakening (v${ghost.schemaVersion})`);
      try {
        await awakenGhost(ghost);
      } catch (err) {
        console.error(`  ❌ Awaken failed: ${err.message}`);
      }
      continue;
    }

    // ── Case 2: Awakened + grace expired + not executed → execute ─────────────
    if (ghost.awakened && !ghost.executed && graceExpiry != null && nowSeconds > graceExpiry + EXECUTION_BUFFER_SECONDS) {
      const overdueMinutes = Math.round((nowSeconds - graceExpiry) / 60);
      console.log(`  💀 ${ghost.owner.slice(0,8)}... grace expired ${overdueMinutes}m ago — executing ${ghost.beneficiaryCount} transfer(s) (v${ghost.schemaVersion})`);
      for (let i = 0; i < ghost.beneficiaryCount; i++) {
        try {
          const sig = await executeTransfer(ghost, i);
          console.log(`  ✅ Beneficiary ${i + 1}/${ghost.beneficiaryCount} — Tx: ${sig}`);
          await sleep(1500);
        } catch (err) {
          console.error(`  ❌ Execute failed for beneficiary ${i}: ${err.message}`);
        }
      }
      continue;
    }

    // ── Healthy ───────────────────────────────────────────────────────────────
    const nextPingIn = heartbeatExpiry - nowSeconds;
    if (nextPingIn > 0) {
      const days  = Math.floor(nextPingIn / 86400);
      const hours = Math.floor((nextPingIn % 86400) / 3600);
      const label = days > 0 ? `~${days}d ${hours}h` : `~${hours}h`;
      console.log(`  ✓  ${ghost.owner.slice(0,8)}... healthy — next deadline in ${label} (v${ghost.schemaVersion}, ${ghost.beneficiaryCount} bene(s))`);
    }
  }

  console.log('  Scan complete.\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    const balance = await connection.getBalance(botKeypair.publicKey);
    console.log(`💰 Bot wallet balance: ${(balance / 1e9).toFixed(4)} SOL`);
    if (balance < 0.01 * 1e9) console.warn('⚠️  Low balance — top up the bot wallet');
  } catch (err) {
    console.error('Could not fetch bot balance:', err.message);
  }

  await scanAndExecute();
  setInterval(scanAndExecute, POLL_INTERVAL_MS);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });