/**
 * GHOST Protocol — Executor Bot v1.8
 *
 * Execution flow per overdue ghost:
 *   1. check_silence      — awakens ghost + pays 5% bounty to bot's $GHOST ATA
 *   2. Wait for grace period to expire (bot re-checks on next poll — does NOT execute early)
 *   3. execute_legacy     — marks ghost.executed = true (permissionless)
 *   4. Per beneficiary:
 *        action=0 → execute_transfer
 *        action=1 → execute_burn
 *   5. If whole_vault_recipient set:
 *        action=0 → execute_whole_vault_transfer
 *        action=1 → execute_whole_vault_burn
 *
 * GRACE PERIOD SAFETY: bot checks Date.now()/1000 > awakenedAt + gracePeriodSeconds
 * before EVER calling execute_legacy or any transfer/burn. On-chain enforces this too
 * (GracePeriodActive error) but we guard client-side to avoid wasting SOL.
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
const GHOST_MINT_ADDR = process.env.GHOST_MINT  || '3Es13GXc4qwttE6uSgAAfi1zvBD3qzLkZpY21KfT3sZ3';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Anchor discriminators — sha256("global:<name>")[0:8]
const DISC = {
  check_silence:                Buffer.from([202,  62, 248,   8, 221, 201, 230, 158]),
  execute_legacy:               Buffer.from([ 71,  64, 249, 123, 104, 220, 188, 144]),
  execute_transfer:             Buffer.from([233, 126, 160, 184, 235, 206,  31, 119]),
  execute_burn:                 Buffer.from([234,  48, 129, 220,  40, 222,  58, 159]),
  execute_whole_vault_transfer: Buffer.from([ 52,  93,  49, 132,  97,  46, 218,  13]),
  execute_whole_vault_burn:     Buffer.from([ 89, 218, 151, 148, 120, 100, 181,  28]),
};

// GhostAccount account discriminator — sha256("account:GhostAccount")[0:8]
const GHOST_ACCOUNT_DISC = Buffer.from([159, 102, 98, 152, 27, 151, 132, 88]);

const TOKEN_PROG_ADDR  = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOC_TOKEN_ADDR = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bso';

// ─── Setup ───────────────────────────────────────────────────────────────────

if (!BOT_KEYPAIR_B58) { console.error('❌ BOT_KEYPAIR env var not set.'); process.exit(1); }

const botKp        = Keypair.fromSecretKey(bs58.decode(BOT_KEYPAIR_B58));
const connection   = new Connection(RPC_URL,    'confirmed');
const gpaConn      = new Connection(GPA_RPC_URL,'confirmed');
const programIdPk  = new PublicKey(PROGRAM_ID);
const ghostMintPk  = new PublicKey(GHOST_MINT_ADDR);
const tokenProgPk  = new PublicKey(TOKEN_PROG_ADDR);
const assocTokenPk = new PublicKey(ASSOC_TOKEN_ADDR);

console.log('👻 GHOST Executor Bot starting...');
console.log('   Program:', PROGRAM_ID);
console.log('   Bot wallet:', botKp.publicKey.toBase58());
console.log('   RPC (tx):', RPC_URL);
console.log('   RPC (gPA):', GPA_RPC_URL);
console.log('   Polling every', POLL_INTERVAL_MS / 60000, 'minutes\n');

// ─── PDA / ATA helpers ───────────────────────────────────────────────────────

const deriveGhostPda  = (ownerPk) => PublicKey.findProgramAddressSync([Buffer.from('ghost'), ownerPk.toBytes()], programIdPk);
const deriveVaultPda  = (ownerPk) => PublicKey.findProgramAddressSync([Buffer.from('vault'), ownerPk.toBytes()], programIdPk);
const deriveStakeVault= (ownerPk) => PublicKey.findProgramAddressSync([Buffer.from('stake_vault'), ownerPk.toBytes()], programIdPk);
const deriveATA       = (walletPk, mintPk, tpk = tokenProgPk) =>
  PublicKey.findProgramAddressSync([walletPk.toBytes(), tpk.toBytes(), mintPk.toBytes()], assocTokenPk)[0];

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

    // awakened_at: Option<i64>
    const hasAwakenedAt = data[o] === 1; o += 1;
    const awakenedAt    = hasAwakenedAt ? Number(view.getBigInt64(o, true)) : null;
    if (hasAwakenedAt) o += 8;

    const executed = data[o] === 1; o += 1;

    // executed_at: Option<i64>
    const hasExecutedAt = data[o] === 1; o += 1;
    if (hasExecutedAt) o += 8;

    o += 8; // staked_ghost
    const bump      = data[o]; o += 1;
    const vaultBump = data[o]; o += 1;
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
      const action    = data[o]; o += 1;
      const bExec     = data[o] === 1; o += 1;
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

    return { pubkey: pubkeyStr, owner, lastHeartbeat, intervalSeconds, gracePeriodSeconds,
             awakened, awakenedAt, executed, bump, vaultBump,
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
    const detail = err?.logs ? '\n' + err.logs.join('\n') : err.message;
    console.error(`    ❌ ${label} failed:`, detail);
    return null;
  }
}

// ─── Instruction builders ─────────────────────────────────────────────────────

function buildCheckSilence(ghost) {
  // CheckSilence accounts: ghost(mut), caller(mut,signer), ghost_mint,
  //   ghost_stake_vault(mut), caller_token_account(mut), token_program
  const ownerPk      = new PublicKey(ghost.owner);
  const ghostPdaPk   = new PublicKey(ghost.pubkey);
  const [stakeVault] = deriveStakeVault(ownerPk);
  const botAta       = deriveATA(botKp.publicKey, ghostMintPk);

  return new TransactionInstruction({
    programId: programIdPk,
    keys: [
      { pubkey: ghostPdaPk,       isSigner: false, isWritable: true  }, // ghost
      { pubkey: botKp.publicKey,  isSigner: true,  isWritable: true  }, // caller
      { pubkey: ghostMintPk,      isSigner: false, isWritable: false }, // ghost_mint
      { pubkey: stakeVault,       isSigner: false, isWritable: true  }, // ghost_stake_vault
      { pubkey: botAta,           isSigner: false, isWritable: true  }, // caller_token_account (bounty)
      { pubkey: tokenProgPk,      isSigner: false, isWritable: false }, // token_program
    ],
    data: DISC.check_silence,
  });
}

function buildExecuteLegacy(ghost) {
  // ExecuteLegacy accounts: ghost(mut), caller(signer)
  return new TransactionInstruction({
    programId: programIdPk,
    keys: [
      { pubkey: new PublicKey(ghost.pubkey), isSigner: false, isWritable: true  }, // ghost
      { pubkey: botKp.publicKey,             isSigner: true,  isWritable: false }, // caller
    ],
    data: DISC.execute_legacy,
  });
}

function buildExecuteTransfer(ghost, bIndex, bene) {
  // ExecuteTransfer accounts: ghost(mut), vault, token_mint(mut), vault_token_account(mut),
  //   recipient, recipient_token_account(mut), token_program, caller(signer)
  // + arg: beneficiary_index (u8)
  const ownerPk      = new PublicKey(ghost.owner);
  const [vaultPk]    = deriveVaultPda(ownerPk);
  const mintPk       = new PublicKey(bene.tokenMint);
  const recipientPk  = new PublicKey(bene.recipient);
  const vaultAta     = deriveATA(vaultPk, mintPk);
  const recipientAta = deriveATA(recipientPk, mintPk);

  const data = Buffer.alloc(9);
  DISC.execute_transfer.copy(data, 0);
  data.writeUInt8(bIndex, 8);

  return new TransactionInstruction({
    programId: programIdPk,
    keys: [
      { pubkey: new PublicKey(ghost.pubkey), isSigner: false, isWritable: true  }, // ghost
      { pubkey: vaultPk,                     isSigner: false, isWritable: false }, // vault
      { pubkey: mintPk,                      isSigner: false, isWritable: true  }, // token_mint
      { pubkey: vaultAta,                    isSigner: false, isWritable: true  }, // vault_token_account
      { pubkey: recipientPk,                 isSigner: false, isWritable: false }, // recipient
      { pubkey: recipientAta,                isSigner: false, isWritable: true  }, // recipient_token_account
      { pubkey: tokenProgPk,                 isSigner: false, isWritable: false }, // token_program
      { pubkey: botKp.publicKey,             isSigner: true,  isWritable: false }, // caller
    ],
    data,
  });
}

function buildExecuteBurn(ghost, bIndex, bene) {
  // ExecuteBurn accounts: ghost(mut), vault, mint(mut), vault_token_account(mut),
  //   token_program, caller(signer)
  // + arg: beneficiary_index (u8)
  const ownerPk   = new PublicKey(ghost.owner);
  const [vaultPk] = deriveVaultPda(ownerPk);
  const mintPk    = new PublicKey(bene.tokenMint);
  const vaultAta  = deriveATA(vaultPk, mintPk);

  const data = Buffer.alloc(9);
  DISC.execute_burn.copy(data, 0);
  data.writeUInt8(bIndex, 8);

  return new TransactionInstruction({
    programId: programIdPk,
    keys: [
      { pubkey: new PublicKey(ghost.pubkey), isSigner: false, isWritable: true  }, // ghost
      { pubkey: vaultPk,                     isSigner: false, isWritable: false }, // vault
      { pubkey: mintPk,                      isSigner: false, isWritable: true  }, // mint
      { pubkey: vaultAta,                    isSigner: false, isWritable: true  }, // vault_token_account
      { pubkey: tokenProgPk,                 isSigner: false, isWritable: false }, // token_program
      { pubkey: botKp.publicKey,             isSigner: true,  isWritable: false }, // caller
    ],
    data,
  });
}

function buildExecuteWholeVaultTransfer(ghost, mintPkStr) {
  // ExecuteWholeVaultTransfer: ghost(mut), vault, token_mint(mut), vault_token_account(mut),
  //   recipient, recipient_token_account(mut), token_program, caller(signer)
  const ownerPk      = new PublicKey(ghost.owner);
  const [vaultPk]    = deriveVaultPda(ownerPk);
  const mintPk       = new PublicKey(mintPkStr);
  const recipientPk  = new PublicKey(ghost.wholeVaultRecipient);
  const vaultAta     = deriveATA(vaultPk, mintPk);
  const recipientAta = deriveATA(recipientPk, mintPk);

  return new TransactionInstruction({
    programId: programIdPk,
    keys: [
      { pubkey: new PublicKey(ghost.pubkey), isSigner: false, isWritable: true  },
      { pubkey: vaultPk,                     isSigner: false, isWritable: false },
      { pubkey: mintPk,                      isSigner: false, isWritable: true  },
      { pubkey: vaultAta,                    isSigner: false, isWritable: true  },
      { pubkey: recipientPk,                 isSigner: false, isWritable: false },
      { pubkey: recipientAta,                isSigner: false, isWritable: true  },
      { pubkey: tokenProgPk,                 isSigner: false, isWritable: false },
      { pubkey: botKp.publicKey,             isSigner: true,  isWritable: false },
    ],
    data: DISC.execute_whole_vault_transfer,
  });
}

function buildExecuteWholeVaultBurn(ghost, mintPkStr) {
  // ExecuteWholeVaultBurn: ghost(mut), vault, token_mint(mut), vault_token_account(mut),
  //   token_program, caller(signer)
  const ownerPk   = new PublicKey(ghost.owner);
  const [vaultPk] = deriveVaultPda(ownerPk);
  const mintPk    = new PublicKey(mintPkStr);
  const vaultAta  = deriveATA(vaultPk, mintPk);

  return new TransactionInstruction({
    programId: programIdPk,
    keys: [
      { pubkey: new PublicKey(ghost.pubkey), isSigner: false, isWritable: true  },
      { pubkey: vaultPk,                     isSigner: false, isWritable: false },
      { pubkey: mintPk,                      isSigner: false, isWritable: true  },
      { pubkey: vaultAta,                    isSigner: false, isWritable: true  },
      { pubkey: tokenProgPk,                 isSigner: false, isWritable: false },
      { pubkey: botKp.publicKey,             isSigner: true,  isWritable: false },
    ],
    data: DISC.execute_whole_vault_burn,
  });
}

// ─── Ghost processing ─────────────────────────────────────────────────────────

async function processGhost(ghost) {
  const now   = Math.floor(Date.now() / 1000);
  const label = ghost.owner.slice(0, 8) + '...';

  // Fully done — nothing to do
  if (ghost.executed && ghost.beneficiaries.every(b => b.executed) && !ghost.wholeVaultRecipient) return;

  // Already executed (execute_legacy done) but some beneficiaries pending
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

    // Overdue — call check_silence to awaken
    const overdueH = Math.floor((silence - ghost.intervalSeconds) / 3600);
    console.log(`  🔔 ${label} overdue by ${overdueH}h — calling check_silence`);
    await sendTx([buildCheckSilence(ghost)], `check_silence(${label})`);
    // Grace period starts now — do NOT execute yet, wait for next poll
    console.log(`  ⏳ ${label} awakened. Grace: ${ghost.gracePeriodSeconds}s — checking again next poll`);
    return;
  }

  // Awakened — check grace period
  if (ghost.awakenedAt === null) {
    console.warn(`  ⚠️  ${label} awakened=true but awakenedAt=null — parse error, skipping`);
    return;
  }

  const graceEnd        = ghost.awakenedAt + ghost.gracePeriodSeconds;
  const secsUntilExpiry = graceEnd - now;

  if (secsUntilExpiry > 0) {
    // Grace period still active — owner can still cancel. Do nothing.
    console.log(`  ⏳ ${label} in grace period — ${Math.floor(secsUntilExpiry/60)}m ${secsUntilExpiry%60}s left`);
    return;
  }

  // Grace expired — call execute_legacy then run beneficiaries
  console.log(`  💀 ${label} grace expired — calling execute_legacy`);
  const ok = await sendTx([buildExecuteLegacy(ghost)], `execute_legacy(${label})`);
  if (!ok) return;

  // Re-fetch fresh state so beneficiary.executed flags are accurate
  const info = await connection.getAccountInfo(new PublicKey(ghost.pubkey));
  if (!info) return;
  const fresh = parseGhost(ghost.pubkey, new Uint8Array(info.data));
  if (fresh) await runBeneficiaries(fresh, label, now);
}

async function runBeneficiaries(ghost, label, now) {
  // Hard guard — never run if grace period still active
  if (ghost.awakenedAt !== null) {
    const graceEnd = ghost.awakenedAt + ghost.gracePeriodSeconds;
    if (now <= graceEnd) {
      console.log(`  ⏳ ${label} grace period still active — not running beneficiaries`);
      return;
    }
  }

  for (let i = 0; i < ghost.beneficiaryCount; i++) {
    const b = ghost.beneficiaries[i];
    if (b.executed) { console.log(`    [${i}] already paid — skip`); continue; }
    if (!b.tokenMint) { console.log(`    [${i}] no token_mint — skip`); continue; }

    if (b.action === 0) {
      await sendTx([buildExecuteTransfer(ghost, i, b)], `execute_transfer[${i}](${label})`);
    } else if (b.action === 1) {
      await sendTx([buildExecuteBurn(ghost, i, b)], `execute_burn[${i}](${label})`);
    } else {
      console.log(`    [${i}] unknown action ${b.action} — skip`);
    }
  }

  // Whole vault
  if (ghost.wholeVaultRecipient) {
    // The vault can hold any token. WHOLE_VAULT_MINT env var tells the bot which mint to use.
    // Defaults to $GHOST mint if not set.
    const wvMint = process.env.WHOLE_VAULT_MINT || GHOST_MINT_ADDR;
    if (ghost.wholeVaultAction === 0) {
      await sendTx([buildExecuteWholeVaultTransfer(ghost, wvMint)], `execute_whole_vault_transfer(${label})`);
    } else if (ghost.wholeVaultAction === 1) {
      await sendTx([buildExecuteWholeVaultBurn(ghost, wvMint)], `execute_whole_vault_burn(${label})`);
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

    const v17 = accounts.filter(a => a.account.data.length === 1228); // 1220 + 8
    const v18 = accounts.filter(a => a.account.data.length === 1229); // 1221 + 8
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