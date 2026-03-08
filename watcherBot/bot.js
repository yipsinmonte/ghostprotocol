/**
 * GHOST Protocol — Executor Bot v1.9
 *
 * Execution flow per overdue ghost:
 *   1. check_silence      — awakens ghost + pays 5% bounty to bot's $GHOST ATA
 *   2. Wait for grace period to expire (bot re-checks on next poll)
 *   3. execute_legacy     — marks ghost.executed = true (permissionless)
 *   4. Per beneficiary (action=0 → transfer, action=1 → burn)
 *        → verify on-chain: re-fetch beneficiary.executed flag after tx
 *   5. Whole vault: enumerate ALL vault token accounts via getTokenAccountsByOwner,
 *        run execute_whole_vault_transfer/burn per mint with balance > 0
 *        → verify on-chain: re-fetch vault token account balance after tx
 *
 * NOTE: Staked $GHOST (ghost_stake_vault) is NOT touched by the bot.
 *       Only the owner can reclaim/burn stake via abandon_ghost.
 *       The bot logs remaining stake for awareness.
 *
 * GRACE PERIOD SAFETY: bot checks unix timestamp > awakenedAt + gracePeriodSeconds
 *   before EVER calling execute_legacy or transfers. On-chain enforces this too.
 */

require('dotenv').config();
const http = require('http');
const {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
} = require('@solana/web3.js');
const bs58 = require('bs58');

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC_URL         = process.env.RPC_URL     || 'https://api.mainnet-beta.solana.com';
const GPA_RPC_URL     = process.env.GPA_RPC_URL || 'https://rpc.ankr.com/solana';
const PROGRAM_ID      = process.env.PROGRAM_ID  || '3Es13GXc4qwttE6uSgAAfi1zvBD3qzLkZpY21KfT3sZ3';
const BOT_KEYPAIR_B58 = process.env.BOT_KEYPAIR;
const GHOST_MINT_ADDR = process.env.GHOST_MINT  || 'k4MxJAdy22Dgd2UTQ9p3etbnaSLUH1q5cEfSRi6pump';
const FEE_KEYPAIR_B58 = process.env.FEE_WALLET_KEYPAIR; // optional — enables auto-swap of fees to SOL

const POLL_INTERVAL_MS  = 30 * 1000; // 30 seconds
const VERIFY_DELAY_MS   = 3000;           // wait 3s after confirm before verifying
const VERIFY_RETRY_MS   = 6000;           // retry delay if verify fails
const VERIFY_RETRIES    = 2;              // max re-fetch attempts

// Anchor discriminators — sha256("global:<n>")[0:8]
const DISC = {
  check_silence:                Buffer.from([202,  62, 248,   8, 221, 201, 230, 158]),
  execute_legacy:               Buffer.from([ 71,  64, 249, 123, 104, 220, 188, 144]),
  execute_transfer:             Buffer.from([233, 126, 160, 184, 235, 206,  31, 119]),
  execute_burn:                 Buffer.from([234,  48, 129, 220,  40, 222,  58, 159]),
  execute_whole_vault_transfer: Buffer.from([ 52,  93,  49, 132,  97,  46, 218,  13]),
  execute_whole_vault_burn:     Buffer.from([ 89, 218, 151, 148, 120, 100, 181,  28]),
};

// GhostAccount discriminator — sha256("account:GhostAccount")[0:8]
const GHOST_ACCOUNT_DISC = Buffer.from([159, 102, 98, 152, 27, 151, 132, 88]);

const TOKEN_PROG_ADDR   = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22_PROG_ADDR = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ASSOC_TOKEN_ADDR  = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bso';

// ─── Setup ───────────────────────────────────────────────────────────────────

if (!BOT_KEYPAIR_B58) { console.error('❌ BOT_KEYPAIR env var not set.'); process.exit(1); }

const botKp         = Keypair.fromSecretKey(bs58.decode(BOT_KEYPAIR_B58));
const connection    = new Connection(RPC_URL,     'confirmed');
const gpaConn       = new Connection(GPA_RPC_URL, 'confirmed');
const programIdPk   = new PublicKey(PROGRAM_ID);
const ghostMintPk   = new PublicKey(GHOST_MINT_ADDR);
const tokenProgPk   = new PublicKey(TOKEN_PROG_ADDR);
const token22ProgPk = new PublicKey(TOKEN22_PROG_ADDR);
const assocTokenPk  = new PublicKey(ASSOC_TOKEN_ADDR);

// Protocol fee wallet — receives 0.5% of executed transfers (v1.9)
const PROTOCOL_FEE_WALLET = new PublicKey('24AhcsPA9b17Vgcj15Gnba2K8d7LbYEgf3pfy89N1NtZ');
const feeKp = FEE_KEYPAIR_B58 ? Keypair.fromSecretKey(bs58.decode(FEE_KEYPAIR_B58)) : null;
if (feeKp) {
  if (feeKp.publicKey.toBase58() !== PROTOCOL_FEE_WALLET.toBase58()) {
    console.error('❌ FEE_WALLET_KEYPAIR does not match PROTOCOL_FEE_WALLET. Auto-swap disabled.');
  } else {
    console.log('   Fee wallet auto-swap: ENABLED');
  }
} else {
  console.log('   Fee wallet auto-swap: DISABLED (set FEE_WALLET_KEYPAIR to enable)');
}
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_SWAP_API = 'https://api.jup.ag/swap/v1';
const SWEEP_MIN_USD = 1.00;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';
const jupHeaders = JUPITER_API_KEY
  ? { 'Content-Type': 'application/json', 'x-api-key': JUPITER_API_KEY }
  : { 'Content-Type': 'application/json' }; // only swap tokens worth more than $0.10

console.log('👻 GHOST Executor Bot v1.9 starting...');
console.log('   Program:', PROGRAM_ID);
console.log('   Bot wallet:', botKp.publicKey.toBase58());
console.log('   RPC (tx):', RPC_URL);
console.log('   RPC (gPA):', GPA_RPC_URL);
console.log('   Polling every', POLL_INTERVAL_MS / 1000, 'seconds\n');

// ─── PDA / ATA helpers ───────────────────────────────────────────────────────

const deriveGhostPda   = (ownerPk) => PublicKey.findProgramAddressSync([Buffer.from('ghost'),       ownerPk.toBytes()], programIdPk);
const deriveVaultPda   = (ownerPk) => PublicKey.findProgramAddressSync([Buffer.from('vault'),       ownerPk.toBytes()], programIdPk);
const deriveStakeVault = (ownerPk) => PublicKey.findProgramAddressSync([Buffer.from('stake_vault'), ownerPk.toBytes()], programIdPk);
const deriveATA        = (walletPk, mintPk, tpk = tokenProgPk) =>
  PublicKey.findProgramAddressSync([walletPk.toBytes(), tpk.toBytes(), mintPk.toBytes()], assocTokenPk)[0];

// ─── Token program resolver ───────────────────────────────────────────────────

const _mintProgCache = new Map();
async function resolveTokenProgram(mintPk) {
  const key = mintPk.toBase58();
  if (_mintProgCache.has(key)) return _mintProgCache.get(key);
  const info = await connection.getAccountInfo(mintPk);
  if (!info) throw new Error(`Mint not found: ${key}`);
  const prog = info.owner.toBase58() === TOKEN22_PROG_ADDR ? token22ProgPk : tokenProgPk;
  _mintProgCache.set(key, prog);
  return prog;
}

// ─── Account parser ───────────────────────────────────────────────────────────

function parseGhost(pubkeyStr, data) {
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let o = 8; // skip discriminator

    const owner = new PublicKey(data.slice(o, o + 32)).toBase58(); o += 32;

    // recovery_wallets: [Option<Pubkey>; 3] — variable
    for (let i = 0; i < 3; i++) { const t = data[o]; o += 1; if (t === 1) o += 32; }

    const lastHeartbeat      = Number(view.getBigInt64(o, true)); o += 8;
    const intervalSeconds    = Number(view.getBigInt64(o, true)); o += 8;
    const gracePeriodSeconds = Number(view.getBigInt64(o, true)); o += 8;

    const awakened = data[o] === 1; o += 1;

    const hasAwakenedAt = data[o] === 1; o += 1;
    const awakenedAt    = hasAwakenedAt ? Number(view.getBigInt64(o, true)) : null;
    if (hasAwakenedAt) o += 8;

    const executed = data[o] === 1; o += 1;

    const hasExecutedAt = data[o] === 1; o += 1;
    if (hasExecutedAt) o += 8;

    const stakedGhost = Number(view.getBigUint64(o, true)); o += 8;
    const bump        = data[o]; o += 1;
    const vaultBump   = data[o]; o += 1;
    o += 8; // registered_at
    o += 8; // ping_count

    const beneficiaryCount = data[o]; o += 1;

    // beneficiaries: [Beneficiary; 10]
    // Each: recipient(32) + amount(u64=8) + token_mint(Option<Pubkey>=1or33) + action(u8=1) + executed(bool=1)
    const beneficiaries = [];
    for (let i = 0; i < 10; i++) {
      const recipient = new PublicKey(data.slice(o, o + 32)).toBase58(); o += 32;
      const amount    = Number(view.getBigUint64(o, true)); o += 8;
      const mTag      = data[o]; o += 1;
      const tokenMint = mTag === 1 ? new PublicKey(data.slice(o, o + 32)).toBase58() : null;
      if (mTag === 1) o += 32;
      const action  = data[o]; o += 1;
      const bExec   = data[o] === 1; o += 1;
      if (i < beneficiaryCount) beneficiaries.push({ recipient, amount, tokenMint, action, executed: bExec });
    }

    // whole_vault_recipient: Option<Pubkey>
    const wvrTag = data[o]; o += 1;
    const wholeVaultRecipient = wvrTag === 1 ? new PublicKey(data.slice(o, o + 32)).toBase58() : null;
    if (wvrTag === 1) o += 32;

    const paused = data[o] === 1; o += 1;

    // pending_owner: Option<Pubkey>
    const poTag = data[o]; o += 1;
    if (poTag === 1) o += 32;

    const wholeVaultAction = data[o]; o += 1;

    // Sanity guards
    const MIN_IV = 3600, MAX_IV = 365 * 24 * 3600;
    const MIN_HB = 1_600_000_000, MAX_HB = 2_000_000_000;
    if (intervalSeconds < MIN_IV || intervalSeconds > MAX_IV) {
      console.warn(`  ⚠️  ${pubkeyStr.slice(0,8)}... implausible interval (${intervalSeconds}s) — skipping`);
      return null;
    }
    if (lastHeartbeat < MIN_HB || lastHeartbeat > MAX_HB) {
      console.warn(`  ⚠️  ${pubkeyStr.slice(0,8)}... implausible heartbeat (${lastHeartbeat}) — skipping`);
      return null;
    }

    return { pubkey: pubkeyStr, owner, lastHeartbeat, intervalSeconds, gracePeriodSeconds,
             awakened, awakenedAt, executed, stakedGhost, bump, vaultBump,
             beneficiaryCount, beneficiaries, wholeVaultRecipient, wholeVaultAction, paused };
  } catch (err) {
    console.warn('  ⚠️  Parse failed for', pubkeyStr, '—', err.message);
    return null;
  }
}

// ─── Send tx ─────────────────────────────────────────────────────────────────

async function sendTx(instructions, label) {
  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: botKp.publicKey });
    tx.add(...instructions);
    tx.sign(botKp);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    console.log(`    ✅ ${label}: ${sig}`);
    return sig;
  } catch (err) {
    const logs = err?.logs ? '\n' + err.logs.join('\n') : '';
    const msg = err?.message || err?.toString() || JSON.stringify(err);
    console.error(`    ❌ ${label} failed: ${msg}${logs}`);
    return null;
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Like sendTx but skips preflight — needed for ATA creation which fails preflight on Helius
async function sendTxSkipPreflight(instructions, label) {
  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: botKp.publicKey });
    tx.add(...instructions);
    tx.sign(botKp);
    const rawTx = tx.serialize();
    const sig = await connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 5 });
    console.log(`    [ata] sent sig=${sig.slice(0,8)}... waiting confirm...`);
    const result = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    if (result.value && result.value.err) {
      const txInfo = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      const logs = txInfo?.meta?.logMessages ? '\n' + txInfo.meta.logMessages.join('\n') : ' (no logs)';
      console.error(`    ❌ ${label} on-chain err: ${JSON.stringify(result.value.err)}${logs}`);
      return null;
    }
    console.log(`    ✅ ${label}: ${sig}`);
    return sig;
  } catch (err) {
    const logs = err?.logs ? '\n' + err.logs.join('\n') : '';
    const msg = err?.message || err?.toString() || JSON.stringify(err);
    console.error(`    ❌ ${label} failed: ${msg}${logs}`);
    return null;
  }
}

// ─── On-chain verification helpers ───────────────────────────────────────────

// After execute_transfer: re-fetch ghost account and check beneficiary[index].executed === true
async function verifyBeneficiaryPaid(ghostPubkey, index, retries = VERIFY_RETRIES) {
  await sleep(VERIFY_DELAY_MS);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const info = await connection.getAccountInfo(new PublicKey(ghostPubkey));
      if (!info) { console.warn(`    ⚠️  verify[${index}]: ghost account not found`); return false; }
      const fresh = parseGhost(ghostPubkey, new Uint8Array(info.data));
      if (!fresh) { console.warn(`    ⚠️  verify[${index}]: parse failed`); return false; }
      const b = fresh.beneficiaries[index];
      if (!b) { console.warn(`    ⚠️  verify[${index}]: beneficiary not in parsed data`); return false; }
      if (b.executed) {
        console.log(`    ✔  verify[${index}]: confirmed on-chain executed=true`);
        return true;
      }
      if (attempt < retries) {
        console.warn(`    ⚠️  verify[${index}]: not yet marked executed (attempt ${attempt+1}/${retries+1}) — retrying in ${VERIFY_RETRY_MS/1000}s`);
        await sleep(VERIFY_RETRY_MS);
      }
    } catch (err) {
      console.warn(`    ⚠️  verify[${index}]: fetch error — ${err.message}`);
      if (attempt < retries) await sleep(VERIFY_RETRY_MS);
    }
  }
  console.error(`    ❌ verify[${index}]: could not confirm on-chain after ${retries+1} attempts`);
  return false;
}

// After execute_whole_vault_transfer/burn: re-fetch vault token account balance
// Returns true if balance is 0 (drained), false if still has tokens
async function verifyVaultDrained(vaultAta, mintStr, retries = VERIFY_RETRIES) {
  await sleep(VERIFY_DELAY_MS);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const info = await connection.getTokenAccountBalance(vaultAta);
      const bal  = Number(info.value.amount);
      if (bal === 0) {
        console.log(`    ✔  verify vault[${mintStr.slice(0,8)}...]: confirmed drained (balance=0)`);
        return true;
      }
      if (attempt < retries) {
        console.warn(`    ⚠️  verify vault[${mintStr.slice(0,8)}...]: balance still ${bal} (attempt ${attempt+1}/${retries+1}) — retrying`);
        await sleep(VERIFY_RETRY_MS);
      }
    } catch (_) {
      // Account closed/gone after burn — that's success
      console.log(`    ✔  verify vault[${mintStr.slice(0,8)}...]: token account gone (burned/closed)`);
      return true;
    }
  }
  console.error(`    ❌ verify vault[${mintStr.slice(0,8)}...]: still has balance after ${retries+1} attempts`);
  return false;
}

// ─── Instruction builders ─────────────────────────────────────────────────────

async function buildCheckSilence(ghost) {
  const ownerPk      = new PublicKey(ghost.owner);
  const ghostPdaPk   = new PublicKey(ghost.pubkey);
  const [stakeVault] = deriveStakeVault(ownerPk);
  const ghostTokenProg = await resolveTokenProgram(ghostMintPk);
  const botAta = process.env.BOT_GHOST_ATA
    ? new PublicKey(process.env.BOT_GHOST_ATA)
    : deriveATA(botKp.publicKey, ghostMintPk, ghostTokenProg);

  console.log(`    [check_silence] token_prog: ${ghostTokenProg.toBase58().slice(0,8)}... botAta: ${botAta.toBase58().slice(0,8)}...`);

  return new TransactionInstruction({
    programId: programIdPk,
    keys: [
      { pubkey: ghostPdaPk,       isSigner: false, isWritable: true  },
      { pubkey: botKp.publicKey,  isSigner: true,  isWritable: true  },
      { pubkey: ghostMintPk,      isSigner: false, isWritable: false },
      { pubkey: stakeVault,       isSigner: false, isWritable: true  },
      { pubkey: botAta,           isSigner: false, isWritable: true  },
      { pubkey: ghostTokenProg,   isSigner: false, isWritable: false },
    ],
    data: DISC.check_silence,
  });
}

function buildExecuteLegacy(ghost) {
  return new TransactionInstruction({
    programId: programIdPk,
    keys: [
      { pubkey: new PublicKey(ghost.pubkey), isSigner: false, isWritable: true  },
      { pubkey: botKp.publicKey,             isSigner: true,  isWritable: false },
    ],
    data: DISC.execute_legacy,
  });
}

async function buildExecuteTransfer(ghost, bIndex, bene, recipientTokenAcct) {
  const ownerPk      = new PublicKey(ghost.owner);
  const [vaultPk]    = deriveVaultPda(ownerPk);
  const mintPk       = new PublicKey(bene.tokenMint);
  const recipientPk  = new PublicKey(bene.recipient);
  const tokenProg    = await resolveTokenProgram(mintPk);
  const vaultAta     = await findVaultTokenAccount(vaultPk, mintPk, tokenProg);
  if (!vaultAta) return null; // vault has no token account for this mint
  const recipientAcctKey = recipientTokenAcct || deriveATA(recipientPk, mintPk, tokenProg);

  // Protocol fee token account — must exist before calling
  const feeTokenAcct = await ensureFeeTokenAccount(mintPk, tokenProg);

  const data = Buffer.alloc(9);
  DISC.execute_transfer.copy(data, 0);
  data.writeUInt8(bIndex, 8);

  return new TransactionInstruction({
    programId: programIdPk,
    keys: [
      { pubkey: new PublicKey(ghost.pubkey), isSigner: false, isWritable: true  },
      { pubkey: vaultPk,                     isSigner: false, isWritable: false },
      { pubkey: mintPk,                      isSigner: false, isWritable: true  },
      { pubkey: vaultAta,                    isSigner: false, isWritable: true  },
      { pubkey: recipientPk,                 isSigner: false, isWritable: false },
      { pubkey: recipientAcctKey,            isSigner: false, isWritable: true  },
      { pubkey: tokenProg,                   isSigner: false, isWritable: false },
      { pubkey: feeTokenAcct,               isSigner: false, isWritable: true  },
      { pubkey: botKp.publicKey,             isSigner: true,  isWritable: false },
    ],
    data,
  });
}

async function buildExecuteBurn(ghost, bIndex, bene) {
  const ownerPk   = new PublicKey(ghost.owner);
  const [vaultPk] = deriveVaultPda(ownerPk);
  const mintPk    = new PublicKey(bene.tokenMint);
  const tokenProg = await resolveTokenProgram(mintPk);
  const vaultAta  = await findVaultTokenAccount(vaultPk, mintPk, tokenProg);
  if (!vaultAta) return null; // vault has no token account for this mint

  const data = Buffer.alloc(9);
  DISC.execute_burn.copy(data, 0);
  data.writeUInt8(bIndex, 8);

  return new TransactionInstruction({
    programId: programIdPk,
    keys: [
      { pubkey: new PublicKey(ghost.pubkey), isSigner: false, isWritable: true  },
      { pubkey: vaultPk,                     isSigner: false, isWritable: false },
      { pubkey: mintPk,                      isSigner: false, isWritable: true  },
      { pubkey: vaultAta,                    isSigner: false, isWritable: true  },
      { pubkey: tokenProg,                   isSigner: false, isWritable: false },
      { pubkey: botKp.publicKey,             isSigner: true,  isWritable: false },
    ],
    data,
  });
}

async function buildExecuteWholeVaultTransfer(ghost, mintPk, tokenProg, vaultAtaPk, recipientTokenAcct) {
  const ownerPk      = new PublicKey(ghost.owner);
  const [vaultPk]    = deriveVaultPda(ownerPk);
  const recipientPk  = new PublicKey(ghost.wholeVaultRecipient);
  const vaultAtaKey  = vaultAtaPk || deriveATA(vaultPk, mintPk, tokenProg);
  const recipientAcctKey = recipientTokenAcct || deriveATA(recipientPk, mintPk, tokenProg);

  // Protocol fee token account — must exist before calling
  const feeTokenAcct = await ensureFeeTokenAccount(mintPk, tokenProg);

  return new TransactionInstruction({
    programId: programIdPk,
    keys: [
      { pubkey: new PublicKey(ghost.pubkey), isSigner: false, isWritable: true  },
      { pubkey: vaultPk,                     isSigner: false, isWritable: false },
      { pubkey: mintPk,                      isSigner: false, isWritable: true  },
      { pubkey: vaultAtaKey,                 isSigner: false, isWritable: true  },
      { pubkey: recipientPk,                 isSigner: false, isWritable: false },
      { pubkey: recipientAcctKey,            isSigner: false, isWritable: true  },
      { pubkey: tokenProg,                   isSigner: false, isWritable: false },
      { pubkey: feeTokenAcct,               isSigner: false, isWritable: true  },
      { pubkey: botKp.publicKey,             isSigner: true,  isWritable: false },
    ],
    data: DISC.execute_whole_vault_transfer,
  });
}

async function buildExecuteWholeVaultBurn(ghost, mintPk, tokenProg, vaultAtaPk) {
  const ownerPk    = new PublicKey(ghost.owner);
  const [vaultPk]  = deriveVaultPda(ownerPk);
  const vaultAtaKey = vaultAtaPk || deriveATA(vaultPk, mintPk, tokenProg);

  return new TransactionInstruction({
    programId: programIdPk,
    keys: [
      { pubkey: new PublicKey(ghost.pubkey), isSigner: false, isWritable: true  },
      { pubkey: vaultPk,                     isSigner: false, isWritable: false },
      { pubkey: mintPk,                      isSigner: false, isWritable: true  },
      { pubkey: vaultAtaKey,                 isSigner: false, isWritable: true  },
      { pubkey: tokenProg,                   isSigner: false, isWritable: false },
      { pubkey: botKp.publicKey,             isSigner: true,  isWritable: false },
    ],
    data: DISC.execute_whole_vault_burn,
  });
}

// ─── Create recipient token account if missing ──────────────────────────────
//
// Bypasses ATA program (fails on Helius with ProgramAccountNotFound).
// Uses SystemProgram.createAccount + InitializeAccount3 with a fresh keypair,
// same approach as the working frontend (buildManualTokenAccountIxs).
// Returns: { pubkey } of the token account, or null on failure.
// If ATA already exists, returns { pubkey: ata }.
// If keypair account is created, returns { pubkey: kp.publicKey, kp } (kp must sign tx).
// ─── Ensure protocol fee wallet has an ATA for this mint ─────────────────────
// Creates a proper Associated Token Account (not a manual keypair) so that
// Jupiter, Phantom, and all standard tools can find the tokens.
// Bot pays the creation cost. Cached per scan cycle.
const _feeAccountCache = {};
async function ensureFeeTokenAccount(mintPk, tokenProg) {
  const mintStr = mintPk.toBase58();
  if (_feeAccountCache[mintStr]) return _feeAccountCache[mintStr];

  const ata = deriveATA(PROTOCOL_FEE_WALLET, mintPk, tokenProg);

  // Check if ATA already exists
  try {
    const info = await connection.getAccountInfo(ata);
    if (info) {
      _feeAccountCache[mintStr] = ata;
      return ata;
    }
  } catch (_) {}

  // Create ATA using Associated Token Program — bot pays, idempotent
  try {
    console.log(`    [fee-ata] Creating ATA for fee wallet · mint ${mintStr.slice(0,8)}...`);
    const createAtaIx = new TransactionInstruction({
      programId: assocTokenPk,
      keys: [
        { pubkey: botKp.publicKey,     isSigner: true,  isWritable: true  },
        { pubkey: ata,                 isSigner: false, isWritable: true  },
        { pubkey: PROTOCOL_FEE_WALLET, isSigner: false, isWritable: false },
        { pubkey: mintPk,              isSigner: false, isWritable: false },
        { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
        { pubkey: tokenProg,           isSigner: false, isWritable: false },
      ],
      data: Buffer.alloc(0),
    });
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: botKp.publicKey });
    tx.add(createAtaIx);
    tx.sign(botKp);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    console.log(`    [fee-ata] ✅ ATA created: ${ata.toBase58().slice(0,8)}... (${sig.slice(0,8)}...)`);
    await sleep(2000);
    _feeAccountCache[mintStr] = ata;
    return ata;
  } catch (err) {
    // ATA might already exist (race condition) — check again
    try {
      const info = await connection.getAccountInfo(ata);
      if (info) { _feeAccountCache[mintStr] = ata; return ata; }
    } catch(_) {}
    console.warn(`    [fee-ata] Failed to create ATA for ${mintStr.slice(0,8)}...: ${err.message}`);
    _feeAccountCache[mintStr] = ata; // return derived ATA anyway — program will create if needed
    return ata;
  }
}

async function ensureRecipientTokenAccount(ownerPk, mintPk, tokenProg) {
  const ata = deriveATA(ownerPk, mintPk, tokenProg);
  console.log(`    [ata] checking ${ata.toBase58().slice(0,8)}... owner=${ownerPk.toBase58().slice(0,8)}... mint=${mintPk.toBase58().slice(0,8)}...`);
  try {
    const info = await connection.getAccountInfo(ata);
    if (info) { console.log(`    [ata] ATA exists`); return { pubkey: ata }; }
  } catch (_) {}

  // ATA doesn't exist — create a manual token account via keypair
  // (ATA program consistently fails on Helius with ProgramAccountNotFound)
  console.log(`    [ata] creating manual token account (bypass ATA program)`);
  const { Keypair } = require('@solana/web3.js');
  const kp = Keypair.generate();

  // Token-2022 accounts with extensions need more space than the base 165 bytes.
  // Read the mint account to determine extension bytes, same as frontend.
  const isToken2022 = tokenProg.toBase58() === TOKEN22_PROG_ADDR;
  let space = 165;
  if (isToken2022) {
    try {
      const mintInfo = await connection.getAccountInfo(mintPk);
      if (mintInfo && mintInfo.data.length > 82) {
        // Token-2022 mint with extensions: account space = 165 + (mintDataLen - 82) + 2
        // +2 for AccountType discriminator prepended to extension data
        const extBytes = mintInfo.data.length - 82;
        space = 165 + 2 + extBytes;
        console.log(`    [ata] Token-2022 detected — mint data: ${mintInfo.data.length} bytes, account space: ${space}`);
      } else {
        space = 165 + 2; // Token-2022 without extensions still needs AccountType byte
      }
    } catch (e) {
      space = 165 + 2; // safe fallback
      console.warn(`    [ata] could not read mint for space calc, using ${space}`);
    }
  }
  const lamports = await connection.getMinimumBalanceForRentExemption(space);

  const createIx = {
    programId: new PublicKey('11111111111111111111111111111111'),
    keys: [
      { pubkey: botKp.publicKey, isSigner: true, isWritable: true },
      { pubkey: kp.publicKey,    isSigner: true, isWritable: true },
    ],
    data: (() => {
      // SystemProgram.createAccount serialization:
      // [0..4] = instruction index (3 = CreateAccount, little-endian u32)
      // [4..12] = lamports (u64 LE)
      // [12..20] = space (u64 LE)
      // [20..52] = programId (32 bytes)
      const buf = Buffer.alloc(52);
      buf.writeUInt32LE(0, 0); // CreateAccount = 0
      buf.writeBigUInt64LE(BigInt(lamports), 4);
      buf.writeBigUInt64LE(BigInt(space), 12);
      Buffer.from(tokenProg.toBytes()).copy(buf, 20);
      return buf;
    })(),
  };

  // InitializeAccount3: opcode 18, then owner pubkey (32 bytes)
  const initData = Buffer.alloc(33);
  initData[0] = 18;
  Buffer.from(ownerPk.toBytes()).copy(initData, 1);
  const initIx = new TransactionInstruction({
    programId: tokenProg,
    keys: [
      { pubkey: kp.publicKey, isSigner: false, isWritable: true },
      { pubkey: mintPk,       isSigner: false, isWritable: false },
    ],
    data: initData,
  });

  // Send tx — kp must also sign
  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: botKp.publicKey });
    tx.add(new TransactionInstruction(createIx));
    tx.add(initIx);
    tx.sign(botKp, kp); // both signers required
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
    const result = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    if (result.value && result.value.err) {
      console.error(`    [ata] manual create on-chain err: ${JSON.stringify(result.value.err)}`);
      return null;
    }
    console.log(`    [ata] manual token account created: ${kp.publicKey.toBase58().slice(0,8)}... sig=${sig.slice(0,8)}...`);
    await sleep(2000);
    return { pubkey: kp.publicKey };
  } catch (err) {
    console.error(`    [ata] manual create failed: ${err.message || String(err)}`);
    return null;
  }
}

// ─── Ghost processing ─────────────────────────────────────────────────────────

async function processGhost(ghost) {
  const now   = Math.floor(Date.now() / 1000);
  const label = ghost.owner.slice(0, 8) + '...';

  // Log stake status for awareness (bot cannot touch it — owner must call abandon_ghost)
  if (ghost.stakedGhost > 0) {
    const stakeFormatted = (ghost.stakedGhost / 1_000_000).toLocaleString();
    console.log(`  💎 ${label} staked: ${stakeFormatted} $GHOST (locked in stake_vault — owner must call abandon_ghost to reclaim)`);
  }

  // Already fully executed and all beneficiaries paid
  const allBenePaid = ghost.beneficiaries.every(b => b.executed);
  if (ghost.executed && allBenePaid && !ghost.wholeVaultRecipient) {
    console.log(`  ✅ ${label} fully executed — nothing to do`);
    return;
  }

  // Already executed — just run remaining beneficiaries/vault
  if (ghost.executed) {
    await runBeneficiaries(ghost, label, now);
    return;
  }

  // Not yet awakened
  if (!ghost.awakened) {
    if (ghost.paused) { console.log(`  ⏸  ${label} paused — skipping`); return; }

    const silence = now - ghost.lastHeartbeat;
    if (silence <= ghost.intervalSeconds) {
      const rem = ghost.intervalSeconds - silence;
      console.log(`  💚 ${label} alive — ${Math.floor(rem/3600)}h ${Math.floor((rem%3600)/60)}m remaining`);
      return;
    }

    const overdueH = Math.floor((silence - ghost.intervalSeconds) / 3600);
    console.log(`  🔔 ${label} overdue by ${overdueH}h — calling check_silence`);
    const ix = await buildCheckSilence(ghost);
    await sendTx([ix], `check_silence(${label})`);
    console.log(`  ⏳ ${label} awakened. Grace: ${ghost.gracePeriodSeconds}s — waiting for next poll`);
    return;
  }

  // Awakened — check grace period
  if (ghost.awakenedAt === null) {
    console.warn(`  ⚠️  ${label} awakened=true but awakenedAt=null — skipping`);
    return;
  }

  const graceEnd        = ghost.awakenedAt + ghost.gracePeriodSeconds;
  const secsUntilExpiry = graceEnd - now;

  if (secsUntilExpiry > 0) {
    console.log(`  ⏳ ${label} in grace period — ${Math.floor(secsUntilExpiry/60)}m ${secsUntilExpiry%60}s left`);
    return;
  }

  // Grace expired — execute
  console.log(`  💀 ${label} grace expired — calling execute_legacy`);
  const ok = await sendTx([buildExecuteLegacy(ghost)], `execute_legacy(${label})`);
  if (!ok) return;

  // Re-fetch fresh on-chain state before running beneficiaries
  const info = await connection.getAccountInfo(new PublicKey(ghost.pubkey));
  if (!info) { console.error(`    ❌ Could not re-fetch ghost after execute_legacy`); return; }
  const fresh = parseGhost(ghost.pubkey, new Uint8Array(info.data));
  if (fresh) await runBeneficiaries(fresh, label, now);
}

// ─── Enumerate vault token accounts ──────────────────────────────────────────

async function getVaultTokenAccounts(vaultPk) {
  // Fetch all token accounts owned by the vault PDA across both token programs
  const results = [];
  for (const progAddr of [TOKEN_PROG_ADDR, TOKEN22_PROG_ADDR]) {
    try {
      const progPk = new PublicKey(progAddr);
      const accts  = await connection.getTokenAccountsByOwner(vaultPk, { programId: progPk });
      for (const { pubkey, account } of accts.value) {
        try {
          // Minimal parse: amount is at offset 64 (u64, 8 bytes) in token account layout
          const data   = account.data;
          const mintPk = new PublicKey(data.slice(0, 32));
          const view   = new DataView(data.buffer, data.byteOffset, data.byteLength);
          const amount = Number(view.getBigUint64(64, true));
          if (amount > 0) {
            results.push({ pubkey, mint: mintPk, amount, tokenProg: progPk });
          }
        } catch (_) {}
      }
    } catch (err) {
      console.warn(`    ⚠️  getTokenAccountsByOwner (${progAddr.slice(0,8)}...) failed: ${err.message}`);
    }
  }
  return results;
}

// Find the actual vault token account for a specific mint.
// Vault token accounts may be manual keypair accounts (not standard ATAs),
// so we must query on-chain rather than deriving the ATA address.
// Caches results per vault+mint to avoid redundant RPC calls within a scan.
const _vaultTokenCache = {};
async function findVaultTokenAccount(vaultPk, mintPk, tokenProg) {
  const cacheKey = vaultPk.toBase58() + ':' + mintPk.toBase58();
  if (_vaultTokenCache[cacheKey]) return _vaultTokenCache[cacheKey];

  // First try the standard ATA
  const ata = deriveATA(vaultPk, mintPk, tokenProg);
  try {
    const info = await connection.getAccountInfo(ata);
    if (info) {
      _vaultTokenCache[cacheKey] = ata;
      return ata;
    }
  } catch (_) {}

  // ATA doesn't exist — scan all vault token accounts for this mint
  try {
    const accts = await connection.getTokenAccountsByOwner(vaultPk, { mint: mintPk });
    if (accts.value.length > 0) {
      const found = accts.value[0].pubkey;
      _vaultTokenCache[cacheKey] = found;
      return found;
    }
  } catch (_) {}

  // Not found
  return null;
}

// ─── Run beneficiaries + whole vault ─────────────────────────────────────────

async function runBeneficiaries(ghost, label, now) {
  // Hard guard — never run if grace period still active
  if (ghost.awakenedAt !== null) {
    const graceEnd = ghost.awakenedAt + ghost.gracePeriodSeconds;
    if (now <= graceEnd) {
      console.log(`  ⏳ ${label} grace still active — not running beneficiaries`);
      return;
    }
  }

  // ── Individual beneficiaries (fixed token/amount per slot) ───────────────
  for (let i = 0; i < ghost.beneficiaryCount; i++) {
    const b = ghost.beneficiaries[i];
    if (b.executed) { console.log(`    [${i}] already paid — skip`); continue; }
    if (!b.tokenMint) { console.log(`    [${i}] no token_mint — skip`); continue; }

    const mintPk    = new PublicKey(b.tokenMint);
    const tokenProg = await resolveTokenProgram(mintPk).catch(() => null);
    if (!tokenProg) { console.warn(`    [${i}] could not resolve token program for mint ${b.tokenMint.slice(0,8)}...`); continue; }

    if (b.action === 0) {
      const recipientPk = new PublicKey(b.recipient);
      // Check vault has token account for this mint before creating recipient accounts
      const ownerPk_ = new PublicKey(ghost.owner);
      const [vaultPk_] = deriveVaultPda(ownerPk_);
      const vaultAcct = await findVaultTokenAccount(vaultPk_, mintPk, tokenProg);
      if (!vaultAcct) { console.warn(`    [${i}] vault has no token account for mint ${b.tokenMint.slice(0,8)}... — skipping`); continue; }
      let recipientAcct = await ensureRecipientTokenAccount(recipientPk, mintPk, tokenProg);
      if (!recipientAcct) {
        const fallbackAta = deriveATA(recipientPk, mintPk, tokenProg);
        try {
          const ataInfo = await connection.getAccountInfo(fallbackAta);
          if (ataInfo) {
            console.log(`    [ata] manual create failed but derived ATA exists — using ${fallbackAta.toBase58().slice(0,8)}...`);
            recipientAcct = { pubkey: fallbackAta };
          }
        } catch(_) {}
      }
      if (!recipientAcct) { console.warn(`    [${i}] could not create recipient token account — skipping`); continue; }
      const ix = await buildExecuteTransfer(ghost, i, b, recipientAcct.pubkey);
      if (!ix) { console.warn(`    [${i}] could not build transfer ix — skipping`); continue; }
      const sig = await sendTx([ix], `execute_transfer[${i}](${label})`);
      if (sig) await verifyBeneficiaryPaid(ghost.pubkey, i);
    } else if (b.action === 1) {
      const ix = await buildExecuteBurn(ghost, i, b);
      if (!ix) { console.warn(`    [${i}] vault has no token account for mint ${b.tokenMint.slice(0,8)}... — skipping`); continue; }
      const sig = await sendTx([ix], `execute_burn[${i}](${label})`);
      if (sig) await verifyBeneficiaryPaid(ghost.pubkey, i);
    } else {
      console.log(`    [${i}] unknown action ${b.action} — skip`);
    }
    // Rate limit protection — pause between beneficiary executions
    if (i < ghost.beneficiaryCount - 1) await sleep(3000);
  }

  // ── Whole vault: enumerate ALL vault token accounts ───────────────────────
  if (ghost.wholeVaultRecipient) {
    const ownerPk   = new PublicKey(ghost.owner);
    const [vaultPk] = deriveVaultPda(ownerPk);

    console.log(`    [whole_vault] enumerating vault token accounts for ${vaultPk.toBase58().slice(0,8)}...`);
    const vaultAccounts = await getVaultTokenAccounts(vaultPk);

    if (vaultAccounts.length === 0) {
      console.log(`    [whole_vault] vault has no token accounts with balance — nothing to do`);
    } else {
      console.log(`    [whole_vault] found ${vaultAccounts.length} token account(s) with balance`);
      let transferred = 0, skipped = 0;

      for (const { pubkey: vaultAta, mint: mintPk, amount, tokenProg } of vaultAccounts) {
        const mintStr = mintPk.toBase58();
        console.log(`    [whole_vault] mint: ${mintStr.slice(0,8)}... amount: ${amount}`);

        if (ghost.wholeVaultAction === 0) {
          const recipientPk = new PublicKey(ghost.wholeVaultRecipient);
          const recipientAcct = await ensureRecipientTokenAccount(recipientPk, mintPk, tokenProg);
          if (!recipientAcct) { console.error(`    ❌ could not create recipient token account for ${mintStr.slice(0,8)}... — skipping`); skipped++; continue; }
          const transferIx = await buildExecuteWholeVaultTransfer(ghost, mintPk, tokenProg, vaultAta, recipientAcct.pubkey);
          const sig = await sendTx([transferIx], `execute_whole_vault_transfer[${mintStr.slice(0,8)}...](${label})`);
          if (sig) { await verifyVaultDrained(vaultAta, mintStr); transferred++; } else skipped++;
        } else if (ghost.wholeVaultAction === 1) {
          const ix  = await buildExecuteWholeVaultBurn(ghost, mintPk, tokenProg, vaultAta);
          const sig = await sendTx([ix], `execute_whole_vault_burn[${mintStr.slice(0,8)}...](${label})`);
          if (sig) { await verifyVaultDrained(vaultAta, mintStr); transferred++; } else skipped++;
        } else {
          console.warn(`    [whole_vault] unknown action ${ghost.wholeVaultAction} for mint ${mintStr.slice(0,8)}...`);
          skipped++;
        }
        // Rate limit protection — pause between token executions
        await sleep(3000);
      }

      const action = ghost.wholeVaultAction === 1 ? 'burned' : 'transferred';
      if (skipped === 0) {
        console.log(`  ✅ Whole vault ${action} successfully — ${transferred}/${vaultAccounts.length} token(s) ${action} to ${ghost.wholeVaultRecipient.slice(0,8)}...`);
      } else {
        console.log(`  ⚠️  Whole vault partial — ${transferred} ${action}, ${skipped} skipped`);
      }
    } // end else (vaultAccounts.length > 0)
  } // end if (ghost.wholeVaultRecipient)

  // Log staked ghost reminder — owner must call abandon_ghost to reclaim
  if (ghost.stakedGhost > 0) {
    const stakeFormatted = (ghost.stakedGhost / 1_000_000).toLocaleString();
    console.log(`    [stake] ${stakeFormatted} $GHOST remains in stake_vault — owner must call abandon_ghost to reclaim (50% burn penalty applies)`);
  }
}

// ─── Main scan loop ───────────────────────────────────────────────────────────

async function scan() {
  console.log(`\n🔍 Scanning... [${new Date().toISOString()}]`);
  // Clear per-scan caches
  Object.keys(_feeAccountCache).forEach(k => delete _feeAccountCache[k]);
  Object.keys(_vaultTokenCache).forEach(k => delete _vaultTokenCache[k]);

  try {
    const bal = await connection.getBalance(botKp.publicKey);
    console.log(`💰 Bot wallet balance: ${(bal / 1e9).toFixed(4)} SOL`);
  } catch (_) {}

  try {
    const accounts = await gpaConn.getProgramAccounts(programIdPk, {
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(GHOST_ACCOUNT_DISC) } }],
    });

    const v17 = accounts.filter(a => a.account.data.length === 1228);
    const v18 = accounts.filter(a => a.account.data.length === 1229);
    console.log(`  Found ${v17.length} v1.7 + ${v18.length} v1.8 = ${accounts.length} account(s)`);

    for (const { pubkey, account } of accounts) {
      const ghost = parseGhost(pubkey.toBase58(), new Uint8Array(account.data));
      if (!ghost) continue;
      await processGhost(ghost);
    }

    console.log('  Scan complete.');
  } catch (err) {
    console.error('  ❌ Scan error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// FEE SWEEP + DASHBOARD — auto-convert execution fees to SOL, track total
// ═══════════════════════════════════════════════════════════════════════

const DASHBOARD_PORT = process.env.PORT || 3000;
const JUPITER_PRICE_API = 'https://api.jup.ag/price/v2?ids=';

// Fee state
// ── Persistent fee tracking ─────────────────────────────────────────────
// Tracks total SOL earned by detecting withdrawals (balance drops between scans).
// Persisted to fee_tracker.json so it survives container restarts.
const fs = require('fs');
const FEE_TRACKER_FILE = './fee_tracker.json';

let feeTracker = { totalWithdrawn: 0, lastKnownBalance: 0, totalSwapped: 0 };

function loadFeeTracker() {
  try {
    if (fs.existsSync(FEE_TRACKER_FILE)) {
      const data = JSON.parse(fs.readFileSync(FEE_TRACKER_FILE, 'utf8'));
      feeTracker = { ...feeTracker, ...data };
      console.log(`   Fee tracker loaded: ${feeTracker.totalWithdrawn.toFixed(6)} SOL withdrawn, ${feeTracker.totalSwapped.toFixed(6)} SOL from swaps`);
    }
  } catch (_) {}
}

function saveFeeTracker() {
  try { fs.writeFileSync(FEE_TRACKER_FILE, JSON.stringify(feeTracker, null, 2)); } catch (_) {}
}

// Call on every snapshot update — detects withdrawals
function trackFeeBalance(currentSol) {
  const prev = feeTracker.lastKnownBalance;
  if (prev > 0 && currentSol < prev) {
    // Balance dropped — user withdrew the difference
    const withdrawn = prev - currentSol;
    feeTracker.totalWithdrawn += withdrawn;
    console.log(`  [tracker] Withdrawal detected: ${withdrawn.toFixed(6)} SOL (lifetime withdrawn: ${feeTracker.totalWithdrawn.toFixed(6)} SOL)`);
  }
  feeTracker.lastKnownBalance = currentSol;
  saveFeeTracker();
}

loadFeeTracker();

let feeSnapshot = {
  solBalance: 0,        // current native SOL in fee wallet
  wsolBalance: 0,       // current wSOL in fee wallet
  totalFeeSol: 0,       // current solBalance + wsolBalance
  totalFeeUsd: 0,
  lifetimeFeeSol: 0,    // current balance + all withdrawals = true lifetime total
  lifetimeFeeUsd: 0,
  totalWithdrawn: 0,    // total SOL withdrawn from fee wallet
  solPrice: 0,
  pendingTokens: [],    // SPL tokens not yet swapped
  pendingUsd: 0,
  lastSwept: null,
  lastUpdated: null,
  botBalance: 0,
  ghostCount: 0,
  swapLog: [],          // recent swap history
};

// ── Get all SPL tokens in fee wallet ────────────────────────────────────
async function getFeeWalletTokens() {
  const tokens = [];
  for (const progAddr of [TOKEN_PROG_ADDR, TOKEN22_PROG_ADDR]) {
    try {
      const progPk = new PublicKey(progAddr);
      const accts = await connection.getTokenAccountsByOwner(PROTOCOL_FEE_WALLET, { programId: progPk });
      for (const { pubkey, account } of accts.value) {
        try {
          const data = account.data;
          const mint = new PublicKey(data.slice(0, 32)).toBase58();
          const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
          const rawAmount = Number(view.getBigUint64(64, true));
          if (rawAmount > 0) {
            let decimals = 6;
            try {
              const mintInfo = await connection.getAccountInfo(new PublicKey(mint));
              if (mintInfo && mintInfo.data.length >= 45) decimals = mintInfo.data[44];
            } catch (_) {}
            const uiAmount = rawAmount / Math.pow(10, decimals);
            tokens.push({ mint, rawAmount, decimals, uiAmount, pubkey, tokenProg: progPk });
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
  return tokens;
}

// ── Swap a single token to SOL via Jupiter ──────────────────────────────
async function swapTokenToSol(token) {
  if (!feeKp || feeKp.publicKey.toBase58() !== PROTOCOL_FEE_WALLET.toBase58()) return null;
  const { mint, rawAmount } = token;
  if (mint === WSOL_MINT) return null; // wSOL handled separately

  try {
    // 1. Get quote
    const quoteUrl = `${JUPITER_SWAP_API}/quote?inputMint=${mint}&outputMint=${WSOL_MINT}&amount=${rawAmount}&slippageBps=100`;
    const quoteRes = await fetch(quoteUrl, { headers: jupHeaders });
    const quote = await quoteRes.json();
    if (quote.error || !quote.outAmount) {
      console.log(`    [sweep] No route for ${mint.slice(0,8)}... — skipping`);
      return null;
    }

    // 2. Get swap transaction
    const swapRes = await fetch(`${JUPITER_SWAP_API}/swap`, {
      method: 'POST',
      headers: jupHeaders,
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: PROTOCOL_FEE_WALLET.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });
    const swapData = await swapRes.json();
    if (swapData.error || !swapData.swapTransaction) {
      console.log(`    [sweep] Swap build failed for ${mint.slice(0,8)}...: ${swapData.error || 'unknown'}`);
      return null;
    }

    // 3. Deserialize, sign, send
    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = require('@solana/web3.js').VersionedTransaction.deserialize(txBuf);
    tx.sign([feeKp]);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    await connection.confirmTransaction(sig, 'confirmed');

    const outSol = Number(quote.outAmount) / 1e9;
    console.log(`    [sweep] ✅ Swapped ${token.uiAmount.toPrecision(4)} ${mint.slice(0,6)}... → ${outSol.toFixed(6)} SOL (${sig.slice(0,8)}...)`);
    return { mint, amountIn: token.uiAmount, solOut: outSol, sig, timestamp: new Date().toISOString() };
  } catch (err) {
    console.warn(`    [sweep] Swap failed for ${mint.slice(0,8)}...: ${err.message}`);
    return null;
  }
}

// ── Sweep all non-SOL tokens to SOL ─────────────────────────────────────
async function sweepFeesToSol() {
  if (!feeKp || feeKp.publicKey.toBase58() !== PROTOCOL_FEE_WALLET.toBase58()) return;
  console.log('  [sweep] Checking fee wallet for tokens to convert...');

  const tokens = await getFeeWalletTokens();

  // ── Step 1: Unwrap any wSOL → native SOL (bot pays tx fee) ──────────
  const wsolToken = tokens.find(t => t.mint === WSOL_MINT);
  if (wsolToken) {
    try {
      console.log(`    [sweep] Unwrapping ${wsolToken.uiAmount.toFixed(6)} wSOL → native SOL`);
      // closeAccount instruction: opcode 9, closes wSOL token account → lamports go to fee wallet
      const closeData = Buffer.alloc(1);
      closeData[0] = 9; // CloseAccount instruction
      const closeIx = new TransactionInstruction({
        programId: new PublicKey(TOKEN_PROG_ADDR),
        keys: [
          { pubkey: wsolToken.pubkey, isSigner: false, isWritable: true  }, // wSOL token account
          { pubkey: PROTOCOL_FEE_WALLET, isSigner: false, isWritable: true  }, // destination (fee wallet gets lamports)
          { pubkey: PROTOCOL_FEE_WALLET, isSigner: true,  isWritable: false }, // owner/authority
        ],
        data: closeData,
      });
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: botKp.publicKey }); // bot pays fee
      tx.add(closeIx);
      tx.sign(botKp, feeKp); // bot pays, fee wallet signs as token account owner
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      console.log(`    [sweep] ✅ Unwrapped wSOL → ${wsolToken.uiAmount.toFixed(6)} SOL (${sig.slice(0,8)}...)`);
      feeSnapshot.swapLog.unshift({ mint: WSOL_MINT, amountIn: wsolToken.uiAmount, solOut: wsolToken.uiAmount, sig, timestamp: new Date().toISOString() });
      if (feeSnapshot.swapLog.length > 50) feeSnapshot.swapLog.pop();
      await sleep(2000);
    } catch (err) {
      console.warn(`    [sweep] wSOL unwrap failed: ${err.message}`);
    }
  }

  // ── Step 2: Consolidate tokens from manual accounts → ATA ────────────
  // The bot creates manual keypair token accounts for the fee wallet.
  // Jupiter only finds tokens at the standard ATA address.
  // Transfer from manual accounts → ATA so Jupiter can swap them.
  const allTokens = await getFeeWalletTokens();
  const byMint = {};
  for (const t of allTokens) {
    if (!byMint[t.mint]) byMint[t.mint] = [];
    byMint[t.mint].push(t);
  }

  for (const [mint, accounts] of Object.entries(byMint)) {
    if (mint === WSOL_MINT) continue;
    if (accounts.length <= 1) continue; // only one account, no consolidation needed

    const tokenProg = accounts[0].tokenProg;
    const ata = deriveATA(PROTOCOL_FEE_WALLET, new PublicKey(mint), tokenProg);
    const ataStr = ata.toBase58();

    // Find which account is the ATA and which are manual
    const manualAccounts = accounts.filter(a => a.pubkey.toBase58() !== ataStr);
    if (manualAccounts.length === 0) continue;

    // Ensure ATA exists
    let ataExists = accounts.some(a => a.pubkey.toBase58() === ataStr);
    if (!ataExists && feeKp) {
      try {
        const createAtaIx = new TransactionInstruction({
          programId: new PublicKey(ASSOC_TOKEN_ADDR),
          keys: [
            { pubkey: botKp.publicKey, isSigner: true, isWritable: true },
            { pubkey: ata, isSigner: false, isWritable: true },
            { pubkey: PROTOCOL_FEE_WALLET, isSigner: false, isWritable: false },
            { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
            { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
            { pubkey: tokenProg, isSigner: false, isWritable: false },
          ],
          data: Buffer.alloc(0),
        });
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const tx = new Transaction({ recentBlockhash: blockhash, feePayer: botKp.publicKey });
        tx.add(createAtaIx);
        tx.sign(botKp);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
        console.log(`    [consolidate] Created ATA for ${mint.slice(0,8)}...`);
        ataExists = true;
        await sleep(2000);
      } catch (e) {
        // ATA might already exist
        try {
          const info = await connection.getAccountInfo(ata);
          if (info) ataExists = true;
        } catch(_) {}
      }
    }

    if (!ataExists || !feeKp) continue;

    // Transfer from each manual account → ATA
    for (const manual of manualAccounts) {
      try {
        const decimals = manual.decimals;
        // transfer_checked: opcode 12, amount (u64 LE), decimals (u8)
        const xferData = Buffer.alloc(10);
        xferData[0] = 12; // TransferChecked
        xferData.writeBigUInt64LE(BigInt(manual.rawAmount), 1);
        xferData[9] = decimals;
        const xferIx = new TransactionInstruction({
          programId: tokenProg,
          keys: [
            { pubkey: manual.pubkey, isSigner: false, isWritable: true },
            { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
            { pubkey: ata, isSigner: false, isWritable: true },
            { pubkey: PROTOCOL_FEE_WALLET, isSigner: true, isWritable: false },
          ],
          data: xferData,
        });
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const tx = new Transaction({ recentBlockhash: blockhash, feePayer: botKp.publicKey });
        tx.add(xferIx);
        tx.sign(botKp, feeKp);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
        console.log(`    [consolidate] ✅ Moved ${manual.uiAmount} ${mint.slice(0,6)}... → ATA (${sig.slice(0,8)}...)`);
        await sleep(2000);
      } catch (e) {
        console.warn(`    [consolidate] Failed for ${mint.slice(0,8)}...: ${e.message}`);
      }
    }
  }

  // Re-fetch tokens after consolidation
  const freshTokens = await getFeeWalletTokens();

  // ── Step 3: Swap consolidated SPL tokens → SOL via Jupiter ──────────
  const nonSol = freshTokens.filter(t => t.mint !== WSOL_MINT);

  if (nonSol.length === 0 && !wsolToken) {
    console.log('  [sweep] No tokens to convert');
    return;
  }

  if (nonSol.length > 0) {
    // Get prices to filter dust
    let prices = {};
    try {
      const ids = nonSol.map(t => t.mint).join(',');
      const res = await fetch(JUPITER_PRICE_API + ids, { headers: jupHeaders });
      const json = await res.json();
      prices = json.data || {};
    } catch (_) {}

    for (const t of nonSol) {
      const price = prices[t.mint]?.price ? parseFloat(prices[t.mint].price) : 0;
      const usdValue = t.uiAmount * price;
      if (usdValue < SWEEP_MIN_USD) {
        if (price > 0) {
          console.log(`    [sweep] ${t.mint.slice(0,8)}... worth $${usdValue.toFixed(4)} — below $${SWEEP_MIN_USD} threshold, skipping`);
        } else {
          console.log(`    [sweep] ${t.mint.slice(0,8)}... no price data — skipping`);
        }
        continue;
      }
      const result = await swapTokenToSol(t);
      if (result) {
        feeSnapshot.swapLog.unshift(result);
        if (feeSnapshot.swapLog.length > 50) feeSnapshot.swapLog.pop();
        feeTracker.totalSwapped += result.solOut;
        saveFeeTracker();
      }
      await sleep(3000); // rate limit between swaps
    }
  }

  feeSnapshot.lastSwept = new Date().toISOString();
  console.log('  [sweep] Done');
}

// ── Update fee snapshot (SOL-focused) ───────────────────────────────────
async function updateFeeSnapshot() {
  try {
    // Native SOL balance in fee wallet
    let solBal = 0;
    try { solBal = await connection.getBalance(PROTOCOL_FEE_WALLET) / 1e9; } catch (_) {}

    // Check for wSOL
    let wsolBal = 0;
    const tokens = await getFeeWalletTokens();
    const wsolToken = tokens.find(t => t.mint === WSOL_MINT);
    if (wsolToken) wsolBal = wsolToken.uiAmount;

    // Pending (unswapped) tokens
    const pending = tokens.filter(t => t.mint !== WSOL_MINT);
    let pendingUsd = 0;
    if (pending.length > 0) {
      try {
        const ids = pending.map(t => t.mint).join(',');
        const res = await fetch(JUPITER_PRICE_API + ids, { headers: jupHeaders });
        const json = await res.json();
        for (const t of pending) {
          const p = json.data?.[t.mint]?.price;
          if (p) { t.usdValue = t.uiAmount * parseFloat(p); pendingUsd += t.usdValue; }
          t.symbol = json.data?.[t.mint]?.mintSymbol || (t.mint.slice(0,4) + '...' + t.mint.slice(-4));
        }
      } catch (_) {}
    }

    // SOL price
    let solPrice = 0;
    try {
      const res = await fetch(JUPITER_PRICE_API + WSOL_MINT, { headers: jupHeaders });
      const json = await res.json();
      solPrice = parseFloat(json.data?.[WSOL_MINT]?.price || '0');
    } catch (_) {}

    const totalSol = solBal + wsolBal;

    // Track withdrawals — detect balance drops
    trackFeeBalance(totalSol);
    const lifetimeFeeSol = totalSol + feeTracker.totalWithdrawn;

    // Bot ops balance
    let botBal = 0;
    try { botBal = await connection.getBalance(botKp.publicKey) / 1e9; } catch (_) {}

    // Ghost count
    let ghostCount = 0;
    try {
      const accounts = await gpaConn.getProgramAccounts(programIdPk, {
        filters: [{ memcmp: { offset: 0, bytes: bs58.encode(GHOST_ACCOUNT_DISC) } }],
        dataSlice: { offset: 0, length: 0 },
      });
      ghostCount = accounts.length;
    } catch (_) {}

    feeSnapshot = {
      ...feeSnapshot,
      solBalance: solBal,
      wsolBalance: wsolBal,
      totalFeeSol: totalSol,
      totalFeeUsd: totalSol * solPrice,
      lifetimeFeeSol,
      lifetimeFeeUsd: lifetimeFeeSol * solPrice,
      totalWithdrawn: feeTracker.totalWithdrawn,
      solPrice,
      pendingTokens: pending,
      pendingUsd,
      lastUpdated: new Date().toISOString(),
      botBalance: botBal,
      ghostCount,
    };

    console.log(`  [dashboard] Current: ${totalSol.toFixed(6)} SOL | Lifetime: ${lifetimeFeeSol.toFixed(6)} SOL ($${(lifetimeFeeSol * solPrice).toFixed(2)}) | Withdrawn: ${feeTracker.totalWithdrawn.toFixed(6)} | Pending: ${pending.length} tokens`);
  } catch (err) {
    console.warn('  [dashboard] Snapshot error:', err.message);
  }
}

// ── Dashboard HTML ──────────────────────────────────────────────────────
function renderDashboard() {
  const s = feeSnapshot;

  const pendingRows = s.pendingTokens.map(t => `
    <tr>
      <td style="color:#c0a0ff">${t.symbol || t.mint.slice(0,8)}</td>
      <td style="text-align:right">${t.uiAmount >= 1000 ? t.uiAmount.toLocaleString(undefined,{maximumFractionDigits:2}) : Number(t.uiAmount.toPrecision(5))}</td>
      <td style="text-align:right;color:#ffaa33">$${(t.usdValue||0) < 0.01 ? '<0.01' : (t.usdValue||0).toFixed(2)}</td>
    </tr>`).join('');

  const swapRows = s.swapLog.slice(0, 20).map(l => `
    <tr>
      <td style="color:#5a5a7a">${l.timestamp?.slice(5,16) || '—'}</td>
      <td>${Number(l.amountIn.toPrecision(4))} ${l.mint.slice(0,6)}...</td>
      <td style="color:#33ff99;text-align:right">${l.solOut.toFixed(6)} SOL</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GHOST — Fee Dashboard</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#07070f;color:#e0dcf8;font-family:'Courier New',monospace;padding:24px}
  h1{font-size:18px;letter-spacing:0.2em;color:#c0a0ff;margin-bottom:8px;text-transform:uppercase}
  .sub{font-size:11px;color:#5a5a7a;letter-spacing:0.15em;margin-bottom:32px}
  .stat-row{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap}
  .stat{padding:16px 20px;border:1px solid rgba(102,51,255,0.2);background:rgba(102,51,255,0.04);flex:1;min-width:140px}
  .stat-label{font-size:10px;letter-spacing:0.15em;color:#5a5a7a;text-transform:uppercase;margin-bottom:6px}
  .stat-value{font-size:22px;font-weight:700}
  .green{color:#33ff99} .purple{color:#c0a0ff} .yellow{color:#ffaa33}
  .section{margin-top:28px;margin-bottom:8px;font-size:13px;letter-spacing:0.15em;color:#c0a0ff;text-transform:uppercase}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th{font-size:10px;letter-spacing:0.12em;color:#5a5a7a;text-transform:uppercase;text-align:left;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.06)}
  td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.03);font-size:13px}
  .footer{margin-top:32px;font-size:10px;color:#3a3a5a;letter-spacing:0.1em}
  @media(max-width:500px){.stat-row{flex-direction:column}.stat{min-width:auto}}
</style>
</head><body>
<h1>👻 Ghost Protocol</h1>
<div class="sub">Execution Fee Dashboard · 0.5% Revenue · Auto-Sweep to SOL</div>

<div class="stat-row">
  <div class="stat">
    <div class="stat-label">Lifetime Fees Earned</div>
    <div class="stat-value green">${s.lifetimeFeeSol.toFixed(6)} SOL</div>
    <div style="font-size:11px;color:#5a5a7a;margin-top:4px">≈ $${s.lifetimeFeeUsd.toFixed(2)}</div>
  </div>
  <div class="stat">
    <div class="stat-label">Current Balance</div>
    <div class="stat-value green">${s.totalFeeSol.toFixed(6)} SOL</div>
    <div style="font-size:11px;color:#5a5a7a;margin-top:4px">≈ $${s.totalFeeUsd.toFixed(2)}</div>
  </div>
  <div class="stat">
    <div class="stat-label">Total Withdrawn</div>
    <div class="stat-value purple">${s.totalWithdrawn.toFixed(6)} SOL</div>
  </div>
</div>

<div class="stat-row">
  <div class="stat">
    <div class="stat-label">Pending Conversion</div>
    <div class="stat-value yellow">${s.pendingTokens.length} token${s.pendingTokens.length===1?'':'s'}</div>
    <div style="font-size:11px;color:#5a5a7a;margin-top:4px">≈ $${s.pendingUsd.toFixed(2)}</div>
  </div>
  <div class="stat">
    <div class="stat-label">Active Ghosts</div>
    <div class="stat-value purple">${s.ghostCount}</div>
  </div>
  <div class="stat">
    <div class="stat-label">Bot Ops Balance</div>
    <div class="stat-value ${s.botBalance < 0.01 ? 'yellow' : 'purple'}">${s.botBalance.toFixed(4)} SOL</div>
  </div>
</div>

<div style="font-size:11px;color:#5a5a7a;margin-bottom:24px">
  SOL price: $${s.solPrice.toFixed(2)} · Last sweep: ${s.lastSwept || 'never'} · Auto-swap: ${feeKp ? '<span style="color:#33ff99">ON</span>' : '<span style="color:#ff6666">OFF</span>'}
</div>

${s.pendingTokens.length > 0 ? `
<div class="section">Pending Conversion</div>
<table>
  <tr><th>Token</th><th style="text-align:right">Amount</th><th style="text-align:right">USD</th></tr>
  ${pendingRows}
</table>` : ''}

${s.swapLog.length > 0 ? `
<div class="section">Recent Swaps</div>
<table>
  <tr><th>Time</th><th>From</th><th style="text-align:right">Received</th></tr>
  ${swapRows}
</table>` : ''}

<div class="footer">Updated: ${s.lastUpdated || 'never'} · Fees refresh every 5m · Sweep runs every 1h · <a href="/" style="color:#7766aa">↻ Reload</a></div>
</body></html>`;
}

// ── HTTP Server ─────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/api/fees') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(feeSnapshot));
  } else if (req.url === '/sweep' && feeKp) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Sweep triggered. Check logs.\n');
    sweepFeesToSol().catch(console.error);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderDashboard());
  }
});
server.listen(DASHBOARD_PORT, () => {
  console.log(`   Dashboard: http://localhost:${DASHBOARD_PORT}`);
});

// ═══════════════════════════════════════════════════════════════════════

(async () => {
  await updateFeeSnapshot();
  await scan();
  setInterval(scan, POLL_INTERVAL_MS);
  setInterval(updateFeeSnapshot, 5 * 60 * 1000);    // refresh dashboard every 5 min
  setInterval(sweepFeesToSol, 60 * 60 * 1000);       // auto-sweep every 1 hour
})();