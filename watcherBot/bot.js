/**
 * GHOST Protocol — Executor Bot
 *
 * Watches all ghost accounts on-chain. When a heartbeat has expired and the
 * grace period is over, this bot submits awaken_ghost then execute_transfer
 * automatically.
 *
 * Deploy on Railway: push to GitHub → connect repo → set env vars → done.
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

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC_URL         = process.env.RPC_URL     || 'https://api.mainnet-beta.solana.com';
const GPA_RPC_URL     = process.env.GPA_RPC_URL || 'https://rpc.ankr.com/solana';
const PROGRAM_ID      = process.env.PROGRAM_ID  || '3Es13GXc4qwttE6uSgAAfi1zvBD3qzLkZpY21KfT3sZ3';
const BOT_KEYPAIR_B58 = process.env.BOT_KEYPAIR;

const POLL_INTERVAL_MS      = 5 * 60 * 1000; // scan every 5 minutes
const EXECUTION_BUFFER_SECS = 60;            // wait 60s past expiry before acting

// Anchor instruction discriminators — sha256("global:<name>")[0:8]
const DISC = {
  awaken_ghost:     Buffer.from([184,  91,  42, 182, 145,  78, 199,  65]),
  execute_transfer: Buffer.from([233, 126, 160, 184, 235, 206,  31, 119]),
};

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// ─── Setup ───────────────────────────────────────────────────────────────────

if (!BOT_KEYPAIR_B58) {
  console.error('❌ BOT_KEYPAIR env var not set.');
  process.exit(1);
}

const botKeypair    = Keypair.fromSecretKey(bs58.decode(BOT_KEYPAIR_B58));
const connection    = new Connection(RPC_URL,     'confirmed');
const gpaConnection = new Connection(GPA_RPC_URL, 'confirmed');
const programIdPk   = new PublicKey(PROGRAM_ID);

console.log('👻 GHOST Executor Bot starting...');
console.log('   Program:', PROGRAM_ID);
console.log('   Bot wallet:', botKeypair.publicKey.toBase58());
console.log('   RPC (tx):', RPC_URL);
console.log('   RPC (gPA):', GPA_RPC_URL);
console.log('   Polling every', POLL_INTERVAL_MS / 60000, 'minutes\n');

// ─── Account Layout Parser ────────────────────────────────────────────────────
//
// GhostAccount Borsh layout (Options are VARIABLE — None=1 byte, Some=1+payload):
//
//   discriminator(8)
//   owner(32)
//   recovery_wallets([Option<Pubkey>; 3])  — 3 slots, each 1 or 33 bytes
//   last_heartbeat(i64=8)
//   interval_seconds(i64=8)
//   grace_period_seconds(i64=8)
//   awakened(bool=1)
//   awakened_at(Option<i64>)               — 1 byte if None, 9 bytes if Some
//   executed(bool=1)
//   executed_at(Option<i64>)               — 1 byte if None, 9 bytes if Some
//   staked_ghost(u64=8)
//   bump(u8=1)
//   vault_bump(u8=1)
//   registered_at(i64=8)
//   ping_count(u64=8)
//   beneficiary_count(u8=1)

function parseGhostAccount(pubkey, data) {
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 8; // skip 8-byte Anchor discriminator

    // owner: Pubkey (32)
    const owner = new PublicKey(data.slice(offset, offset + 32)).toBase58();
    offset += 32;

    // recovery_wallets: [Option<Pubkey>; 3]
    // Each slot: tag(1) + pubkey(32) if Some, tag(1) only if None.
    // Must parse all 3 dynamically — do NOT assume fixed 33 bytes per slot.
    const recoveryWallets = [];
    for (let i = 0; i < 3; i++) {
      const tag = data[offset]; offset += 1;
      if (tag === 1) {
        recoveryWallets.push(new PublicKey(data.slice(offset, offset + 32)).toBase58());
        offset += 32;
      } else {
        recoveryWallets.push(null); // None — tag byte already consumed, no extra bytes
      }
    }

    // last_heartbeat: i64
    const lastHeartbeat = Number(view.getBigInt64(offset, true)); offset += 8;

    // interval_seconds: i64
    const intervalSeconds = Number(view.getBigInt64(offset, true)); offset += 8;

    // grace_period_seconds: i64
    const gracePeriodSeconds = Number(view.getBigInt64(offset, true)); offset += 8;

    // awakened: bool
    const awakened = data[offset] === 1; offset += 1;

    // awakened_at: Option<i64> — None=1 byte, Some=9 bytes
    const hasAwakenedAt = data[offset] === 1; offset += 1;
    const awakenedAt = hasAwakenedAt ? Number(view.getBigInt64(offset, true)) : null;
    if (hasAwakenedAt) offset += 8;

    // executed: bool
    const executed = data[offset] === 1; offset += 1;

    // executed_at: Option<i64> — None=1 byte, Some=9 bytes
    const hasExecutedAt = data[offset] === 1; offset += 1;
    if (hasExecutedAt) offset += 8;

    // staked_ghost: u64
    const stakedGhost = Number(view.getBigUint64(offset, true)); offset += 8;

    // bump: u8, vault_bump: u8
    offset += 2;

    // registered_at: i64
    const registeredAt = Number(view.getBigInt64(offset, true)); offset += 8;

    // ping_count: u64
    const pingCount = Number(view.getBigUint64(offset, true)); offset += 8;

    // beneficiary_count: u8
    const beneficiaryCount = data[offset];

    return {
      pubkey: pubkey.toBase58(),
      owner,
      recoveryWallets,
      lastHeartbeat,
      intervalSeconds,
      gracePeriodSeconds,
      awakened,
      awakenedAt,
      executed,
      stakedGhost,
      registeredAt,
      pingCount,
      beneficiaryCount,
    };
  } catch (err) {
    console.warn('  ⚠️  Failed to parse', pubkey.toBase58(), '—', err.message);
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
  const [ghostPda] = deriveGhostPda(new PublicKey(ghost.owner));

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

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');
  console.log(`  ✅ Ghost awakened. Tx: ${sig}`);
  return sig;
}

// ─── Execute Transfer ─────────────────────────────────────────────────────────

async function executeTransfer(ghost, beneficiaryIndex) {
  const [ghostPda] = deriveGhostPda(new PublicKey(ghost.owner));
  const [vaultPda] = deriveVaultPda(ghostPda);

  // Instruction data: discriminator(8) + beneficiary_index(u8=1)
  const data = Buffer.alloc(9);
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

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

// ─── Main Scan Loop ───────────────────────────────────────────────────────────

async function scanAndExecute() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  console.log(`\n🔍 Scanning... [${new Date().toISOString()}]`);

  let accounts;
  try {
    const ACCOUNT_SIZE_V17 = 1228;
    const ACCOUNT_SIZE_V18 = 1229;
    const [v17, v18] = await Promise.all([
      gpaConnection.getProgramAccounts(programIdPk, {
        commitment: 'confirmed',
        filters: [{ dataSize: ACCOUNT_SIZE_V17 }],
      }),
      gpaConnection.getProgramAccounts(programIdPk, {
        commitment: 'confirmed',
        filters: [{ dataSize: ACCOUNT_SIZE_V18 }],
      }),
    ]);
    // Deduplicate by pubkey
    const seen = new Set();
    accounts = [];
    for (const a of [...v17, ...v18]) {
      const key = a.pubkey.toBase58();
      if (!seen.has(key)) { seen.add(key); accounts.push(a); }
    }
    console.log(`  Found ${v17.length} v1.7 + ${v18.length} v1.8 = ${accounts.length} account(s)`);
  } catch (err) {
    console.error('  ❌ gPA error:', err.message);
    return;
  }

  for (const { pubkey, account } of accounts) {
    const data  = new Uint8Array(account.data);
    const ghost = parseGhostAccount(pubkey, data);
    if (!ghost) continue;

    // Sanity guard: interval must be plausible (1h–365d).
    // If parse went wrong the interval will be a garbage number.
    const MIN_INTERVAL = 3600;
    const MAX_INTERVAL = 365 * 24 * 3600;
    if (ghost.intervalSeconds < MIN_INTERVAL || ghost.intervalSeconds > MAX_INTERVAL) {
      console.warn(`  ⚠️  ${ghost.owner.slice(0, 8)}... implausible interval (${ghost.intervalSeconds}s) — skipping`);
      continue;
    }

    const heartbeatExpiry = ghost.lastHeartbeat + ghost.intervalSeconds;
    const graceExpiry     = ghost.awakenedAt != null
      ? ghost.awakenedAt + ghost.gracePeriodSeconds
      : null;

    // ── Case 1: Heartbeat expired, not yet awakened → awaken ─────────────────
    if (!ghost.awakened && !ghost.executed && nowSeconds > heartbeatExpiry + EXECUTION_BUFFER_SECS) {
      const overdueH = Math.round((nowSeconds - heartbeatExpiry) / 3600);
      console.log(`  ⚠️  ${ghost.owner.slice(0, 8)}... overdue by ${overdueH}h — awakening`);
      try {
        await awakenGhost(ghost);
      } catch (err) {
        console.error(`  ❌ Awaken failed: ${err.message}`);
      }
      continue;
    }

    // ── Case 2: Awakened, grace expired, not executed → execute ──────────────
    if (ghost.awakened && !ghost.executed && graceExpiry != null && nowSeconds > graceExpiry + EXECUTION_BUFFER_SECS) {
      const overdueM = Math.round((nowSeconds - graceExpiry) / 60);
      console.log(`  💀 ${ghost.owner.slice(0, 8)}... grace expired ${overdueM}m ago — executing ${ghost.beneficiaryCount} transfer(s)`);

      for (let i = 0; i < ghost.beneficiaryCount; i++) {
        try {
          const sig = await executeTransfer(ghost, i);
          console.log(`  ✅ Beneficiary ${i + 1}/${ghost.beneficiaryCount} transferred. Tx: ${sig}`);
          await sleep(1500);
        } catch (err) {
          console.error(`  ❌ Execute failed for beneficiary ${i}: ${err.message}`);
        }
      }
      continue;
    }

    // ── Healthy — log next ping deadline ─────────────────────────────────────
    const nextPingInDays = Math.round((heartbeatExpiry - nowSeconds) / 86400);
    if (nextPingInDays > 0) {
      console.log(`  ✓  ${ghost.owner.slice(0, 8)}... healthy — next ping due in ~${nextPingInDays}d`);
    } else if (!ghost.awakened && !ghost.executed) {
      console.log(`  ⏳ ${ghost.owner.slice(0, 8)}... heartbeat expired, within buffer — watching`);
    }
  }

  console.log('  Scan complete.');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    const balance = await connection.getBalance(botKeypair.publicKey);
    console.log(`💰 Bot wallet balance: ${(balance / 1e9).toFixed(4)} SOL`);
    if (balance < 0.01 * 1e9) {
      console.warn('⚠️  Low balance — top up bot wallet or transactions will fail');
    }
  } catch (err) {
    console.error('Could not fetch bot balance:', err.message);
  }

  await scanAndExecute();
  setInterval(scanAndExecute, POLL_INTERVAL_MS);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});