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

const POLL_INTERVAL_MS  = 5 * 60 * 1000; // 5 minutes
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

console.log('👻 GHOST Executor Bot v1.9 starting...');
console.log('   Program:', PROGRAM_ID);
console.log('   Bot wallet:', botKp.publicKey.toBase58());
console.log('   RPC (tx):', RPC_URL);
console.log('   RPC (gPA):', GPA_RPC_URL);
console.log('   Polling every', POLL_INTERVAL_MS / 60000, 'minutes\n');

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

async function buildExecuteTransfer(ghost, bIndex, bene) {
  const ownerPk      = new PublicKey(ghost.owner);
  const [vaultPk]    = deriveVaultPda(ownerPk);
  const mintPk       = new PublicKey(bene.tokenMint);
  const recipientPk  = new PublicKey(bene.recipient);
  const tokenProg    = await resolveTokenProgram(mintPk);
  const vaultAta     = deriveATA(vaultPk, mintPk, tokenProg);
  const recipientAta = deriveATA(recipientPk, mintPk, tokenProg);

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
      { pubkey: recipientAta,                isSigner: false, isWritable: true  },
      { pubkey: tokenProg,                   isSigner: false, isWritable: false },
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
  const vaultAta  = deriveATA(vaultPk, mintPk, tokenProg);

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
  // Use provided recipient token account (may be manual keypair, not ATA)
  const recipientAcctKey = recipientTokenAcct || deriveATA(recipientPk, mintPk, tokenProg);

  return new TransactionInstruction({
    programId: programIdPk,
    keys: [
      { pubkey: new PublicKey(ghost.pubkey), isSigner: false, isWritable: true  },
      { pubkey: vaultPk,                     isSigner: false, isWritable: false },
      { pubkey: mintPk,                      isSigner: false, isWritable: true  },
      { pubkey: vaultAtaKey,                 isSigner: false, isWritable: true  },
      { pubkey: recipientPk,                 isSigner: false, isWritable: false },
      { pubkey: recipientAcctKey,                isSigner: false, isWritable: true  },
      { pubkey: tokenProg,                   isSigner: false, isWritable: false },
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
  const space = 165;
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
      tokenProg.toBytes().copy(buf, 20);
      return buf;
    })(),
  };

  // InitializeAccount3: opcode 18, then owner pubkey (32 bytes)
  const initData = Buffer.alloc(33);
  initData[0] = 18;
  ownerPk.toBytes().copy(initData, 1);
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
      const ix = await buildExecuteTransfer(ghost, i, b);
      const sig = await sendTx([ix], `execute_transfer[${i}](${label})`);
      if (sig) await verifyBeneficiaryPaid(ghost.pubkey, i);
    } else if (b.action === 1) {
      const ix = await buildExecuteBurn(ghost, i, b);
      const sig = await sendTx([ix], `execute_burn[${i}](${label})`);
      if (sig) await verifyBeneficiaryPaid(ghost.pubkey, i);
    } else {
      console.log(`    [${i}] unknown action ${b.action} — skip`);
    }
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

      for (const { pubkey: vaultAta, mint: mintPk, amount, tokenProg } of vaultAccounts) {
        const mintStr = mintPk.toBase58();
        // wSOL (So111...) is a real SPL token account — transfer proceeds as normal.
        // Recipient receives wSOL and can unwrap to native SOL themselves via closeAccount.
        console.log(`    [whole_vault] mint: ${mintStr.slice(0,8)}... amount: ${amount}`);

        if (ghost.wholeVaultAction === 0) {
          // Ensure recipient has a token account — sent as separate confirmed tx before transfer
          const recipientPk = new PublicKey(ghost.wholeVaultRecipient);
          const recipientAcct = await ensureRecipientTokenAccount(recipientPk, mintPk, tokenProg);
          if (!recipientAcct) { console.error(`    ❌ could not create recipient token account for ${mintStr.slice(0,8)}... — skipping`); continue; }
          // Pass actual recipient token account pubkey to transfer builder
          const transferIx = await buildExecuteWholeVaultTransfer(ghost, mintPk, tokenProg, vaultAta, recipientAcct.pubkey);
          const sig = await sendTx([transferIx], `execute_whole_vault_transfer[${mintStr.slice(0,8)}...](${label})`);
          if (sig) await verifyVaultDrained(vaultAta, mintStr);
        } else if (ghost.wholeVaultAction === 1) {
          // Burn — pass actual vault token account pubkey
          const ix  = await buildExecuteWholeVaultBurn(ghost, mintPk, tokenProg, vaultAta);
          const sig = await sendTx([ix], `execute_whole_vault_burn[${mintStr.slice(0,8)}...](${label})`);
          if (sig) await verifyVaultDrained(vaultAta, mintStr);
        } else {
          console.warn(`    [whole_vault] unknown action ${ghost.wholeVaultAction} for mint ${mintStr.slice(0,8)}...`);
        }
      }
    }

    // Log staked ghost reminder — owner must call abandon_ghost to reclaim
    if (ghost.stakedGhost > 0) {
      const stakeFormatted = (ghost.stakedGhost / 1_000_000).toLocaleString();
      console.log(`    [stake] ${stakeFormatted} $GHOST remains in stake_vault — owner must call abandon_ghost to reclaim (50% burn penalty applies)`);
    }
  }
}

// ─── Main scan loop ───────────────────────────────────────────────────────────

async function scan() {
  console.log(`\n🔍 Scanning... [${new Date().toISOString()}]`);

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

(async () => {
  await scan();
  setInterval(scan, POLL_INTERVAL_MS);
})();