import "dotenv/config";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import * as fs from "fs";
import { sendAndConfirmOptimisedTx, setupTokenAccount } from "../utils/helper";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { VoltrClient } from "@voltr/vault-sdk";
import {
  vaultAddress,
  assetMintAddress,
  assetTokenProgram,
  depositAmountVault,
} from "../../config/base";

const userKpFile = fs.readFileSync(process.env.USER_FILE_PATH!, "utf-8");
const userKpData = JSON.parse(userKpFile);
const userSecret = Uint8Array.from(userKpData);
const userKp = Keypair.fromSecretKey(userSecret);
const user = userKp.publicKey;

const vault = new PublicKey(vaultAddress);
const vaultAssetMint = new PublicKey(assetMintAddress);

const connection = new Connection(process.env.HELIUS_RPC_URL!);
const vc = new VoltrClient(connection);
const depositAmount = new BN(depositAmountVault);

const depositVaultHandler = async () => {
  let ixs: TransactionInstruction[] = [];
  const userAssetAta = getAssociatedTokenAddressSync(NATIVE_MINT, user);
  if (vaultAssetMint.equals(NATIVE_MINT)) {
    // Find the WSOL Associated Token Account (ATA)
    // Create WSOL ATA instruction
    const createWsolAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      user,
      userAssetAta,
      user,
      NATIVE_MINT
    );

    // Transfer SOL to WSOL ATA instruction
    const transferSolToWsolIx = SystemProgram.transfer({
      fromPubkey: user,
      toPubkey: userAssetAta,
      lamports: depositAmount.toNumber(),
    });

    // Sync native (convert SOL to WSOL) instruction
    const syncNativeIx = createSyncNativeInstruction(userAssetAta);

    ixs.push(createWsolAtaIx, transferSolToWsolIx, syncNativeIx);
  }

  const { vaultLpMint } = vc.findVaultAddresses(vault);
  const _userLpAta = await setupTokenAccount(
    connection,
    user,
    vaultLpMint,
    user,
    ixs
  );

  const depositVaultIx = await vc.createDepositVaultIx(depositAmount, {
    vault,
    userTransferAuthority: user,
    vaultAssetMint,
    assetTokenProgram: new PublicKey(assetTokenProgram),
  });
  ixs.push(depositVaultIx);

  if (vaultAssetMint.equals(NATIVE_MINT)) {
    // Create close account instruction to convert wSOL back to SOL
    const closeWsolAccountIx = createCloseAccountInstruction(
      userAssetAta, // Account to close
      user, // Destination account (SOL will be sent here)
      user, // Authority
      [] // No multisig signers
    );
    ixs.push(closeWsolAccountIx);
  }

  const txSig = await sendAndConfirmOptimisedTx(
    ixs,
    process.env.HELIUS_RPC_URL!,
    userKp
  );
  console.log("Deposit Vault Tx Sig: ", txSig);
};

depositVaultHandler();
