import "dotenv/config";
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { createWithSeedSync } from "@coral-xyz/anchor/dist/cjs/utils/pubkey";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  sendAndConfirmOptimisedTx,
  setupAddressLookupTable,
  setupTokenAccount,
} from "../utils/helper";
import { BN } from "@coral-xyz/anchor";
import * as fs from "fs";
import {
  LENDING_ADAPTOR_PROGRAM_ID,
  SEEDS,
  VoltrClient,
} from "@voltr/vault-sdk";
import {
  assetMintAddress,
  assetTokenProgram,
  lookupTableAddress,
  useLookupTable,
  vaultAddress,
} from "../../config/base";
import {
  driftMarketIndex,
  klendLendingMarket,
  marginfiBank,
  outputMintAddress,
  solendCollateralMint,
  solendCounterpartyTa,
} from "../../config/lend";
import { PROTOCOL_CONSTANTS } from "../constants/lend";

const payerKpFile = fs.readFileSync(process.env.MANAGER_FILE_PATH!, "utf-8");
const payerKpData = JSON.parse(payerKpFile);
const payerSecret = Uint8Array.from(payerKpData);
const payerKp = Keypair.fromSecretKey(payerSecret);
const payer = payerKp.publicKey;

const vault = new PublicKey(vaultAddress);
const vaultAssetMint = new PublicKey(assetMintAddress);
const vaultAssetTokenProgram = new PublicKey(assetTokenProgram);
const vaultOutputMint = new PublicKey(outputMintAddress);

const connection = new Connection(process.env.HELIUS_RPC_URL!);
const vc = new VoltrClient(connection);

const initSolendStrategy = async (
  protocolProgram: PublicKey,
  counterPartyTa: PublicKey,
  lendingMarket: PublicKey,
  collateralMint: PublicKey
) => {
  const [strategy] = PublicKey.findProgramAddressSync(
    [SEEDS.STRATEGY, counterPartyTa.toBuffer()],
    LENDING_ADAPTOR_PROGRAM_ID
  );

  const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(vault, strategy);

  const obligation = createWithSeedSync(
    vaultStrategyAuth,
    lendingMarket.toBase58().slice(0, 32),
    protocolProgram
  );

  let transactionIxs: TransactionInstruction[] = [];

  const vaultCollateralAta = await setupTokenAccount(
    connection,
    payer,
    collateralMint,
    vaultStrategyAuth,
    transactionIxs
  );

  const vaultStrategyAssetAta = await setupTokenAccount(
    connection,
    payer,
    vaultAssetMint,
    vaultStrategyAuth,
    transactionIxs,
    vaultAssetTokenProgram
  );

  const createInitializeStrategyIx = await vc.createInitializeStrategyIx(
    {},
    {
      payer,
      vault,
      manager: payer,
      strategy,
      remainingAccounts: [
        { pubkey: protocolProgram, isSigner: false, isWritable: false },
        { pubkey: obligation, isSigner: false, isWritable: true },
        { pubkey: lendingMarket, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        {
          pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
          isSigner: false,
          isWritable: false,
        },
      ],
    }
  );

  transactionIxs.push(createInitializeStrategyIx);

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    process.env.HELIUS_RPC_URL!,
    payerKp
  );
  console.log("Solend strategy initialized with signature:", txSig);

  if (useLookupTable) {
    const transactionIxs1: TransactionInstruction[] = [];

    await setupAddressLookupTable(
      connection,
      payer,
      payer,
      [
        ...new Set([
          ...createInitializeStrategyIx.keys.map((k) => k.pubkey.toBase58()),
          vaultStrategyAssetAta.toBase58(),
        ]),
      ],
      transactionIxs1,
      new PublicKey(lookupTableAddress)
    );

    const txSig1 = await sendAndConfirmOptimisedTx(
      transactionIxs1,
      process.env.HELIUS_RPC_URL!,
      payerKp,
      [],
      undefined,
      50_000
    );

    console.log("LUT updated with signature:", txSig1);
  }
};

const initMarginfiStrategy = async (
  protocolProgram: PublicKey,
  bank: PublicKey,
  group: PublicKey
) => {
  const [counterPartyTa] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_vault"), bank.toBuffer()],
    protocolProgram
  );

  const [strategy] = PublicKey.findProgramAddressSync(
    [SEEDS.STRATEGY, counterPartyTa.toBuffer()],
    LENDING_ADAPTOR_PROGRAM_ID
  );

  const marginfiAccountKp = Keypair.generate();
  const marginfiAccount = marginfiAccountKp.publicKey;

  const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(vault, strategy);

  let transactionIxs: TransactionInstruction[] = [];

  const vaultStrategyAssetAta = await setupTokenAccount(
    connection,
    payer,
    vaultAssetMint,
    vaultStrategyAuth,
    transactionIxs,
    vaultAssetTokenProgram
  );

  const createInitializeStrategyIx = await vc.createInitializeStrategyIx(
    {},
    {
      payer,
      vault,
      manager: payer,
      strategy,
      remainingAccounts: [
        { pubkey: protocolProgram, isSigner: false, isWritable: false },
        { pubkey: group, isSigner: false, isWritable: false },
        { pubkey: marginfiAccount, isSigner: true, isWritable: true },
      ],
    }
  );

  transactionIxs.push(createInitializeStrategyIx);

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    process.env.HELIUS_RPC_URL!,
    payerKp,
    [marginfiAccountKp]
  );
  console.log("Marginfi strategy initialized with signature:", txSig);
  console.log(`Update address into variables.ts`);
  console.log("Marginfi account:", marginfiAccount.toBase58());

  if (useLookupTable) {
    const transactionIxs1: TransactionInstruction[] = [];

    await setupAddressLookupTable(
      connection,
      payer,
      payer,
      [
        ...new Set([
          ...createInitializeStrategyIx.keys.map((k) => k.pubkey.toBase58()),
          vaultStrategyAssetAta.toBase58(),
        ]),
      ],
      transactionIxs1,
      new PublicKey(lookupTableAddress)
    );

    const txSig1 = await sendAndConfirmOptimisedTx(
      transactionIxs1,
      process.env.HELIUS_RPC_URL!,
      payerKp,
      [],
      undefined,
      50_000
    );

    console.log("LUT updated with signature:", txSig1);
  }
};

const initKlendStrategy = async (
  protocolProgram: PublicKey,
  lendingMarket: PublicKey
) => {
  const [counterPartyTa] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("reserve_liq_supply"),
      lendingMarket.toBuffer(),
      vaultOutputMint.toBuffer(),
    ],
    protocolProgram
  );

  const [strategy] = PublicKey.findProgramAddressSync(
    [SEEDS.STRATEGY, counterPartyTa.toBuffer()],
    LENDING_ADAPTOR_PROGRAM_ID
  );

  const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(vault, strategy);

  const [userMetadata] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_meta"), vaultStrategyAuth.toBuffer()],
    protocolProgram
  );

  const [_lookupTableIxs, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: vaultStrategyAuth,
      payer: payer,
      recentSlot: await connection.getSlot("confirmed"),
    });

  const [reserveCollateralMint] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("reserve_coll_mint"),
      lendingMarket.toBuffer(),
      vaultOutputMint.toBuffer(),
    ],
    protocolProgram
  );

  let transactionIxs: TransactionInstruction[] = [];

  const vaultStrategyAssetAta = await setupTokenAccount(
    connection,
    payer,
    vaultAssetMint,
    vaultStrategyAuth,
    transactionIxs,
    vaultAssetTokenProgram
  );

  const userDestinationCollateral = await setupTokenAccount(
    connection,
    payer,
    reserveCollateralMint,
    vaultStrategyAuth,
    transactionIxs
  );

  const createInitializeStrategyIx = await vc.createInitializeStrategyIx(
    {},
    {
      payer,
      vault,
      manager: payer,
      strategy,
      remainingAccounts: [
        { pubkey: protocolProgram, isSigner: false, isWritable: false },
        { pubkey: userMetadata, isSigner: false, isWritable: true },
        { pubkey: lookupTableAddress, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
    }
  );

  transactionIxs.push(createInitializeStrategyIx);

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    process.env.HELIUS_RPC_URL!,
    payerKp
  );
  console.log("Klend strategy initialized with signature:", txSig);

  if (useLookupTable) {
    const transactionIxs1: TransactionInstruction[] = [];

    await setupAddressLookupTable(
      connection,
      payer,
      payer,
      [
        ...new Set([
          ...createInitializeStrategyIx.keys.map((k) => k.pubkey.toBase58()),
          vaultStrategyAssetAta.toBase58(),
        ]),
      ],
      transactionIxs1,
      new PublicKey(lookupTableAddress)
    );

    const txSig1 = await sendAndConfirmOptimisedTx(
      transactionIxs1,
      process.env.HELIUS_RPC_URL!,
      payerKp,
      [],
      undefined,
      50_000
    );

    console.log("LUT updated with signature:", txSig1);
  }
};

const initDriftStrategy = async (
  protocolProgram: PublicKey,
  state: PublicKey,
  marketIndex: BN,
  subAccountId: BN
) => {
  const [counterPartyTa] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("spot_market_vault"),
      marketIndex.toArrayLike(Buffer, "le", 2),
    ],
    protocolProgram
  );

  const [strategy] = PublicKey.findProgramAddressSync(
    [SEEDS.STRATEGY, counterPartyTa.toBuffer()],
    LENDING_ADAPTOR_PROGRAM_ID
  );

  const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(vault, strategy);
  const [userStats] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_stats"), vaultStrategyAuth.toBuffer()],
    protocolProgram
  );

  const [user] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("user"),
      vaultStrategyAuth.toBuffer(),
      subAccountId.toArrayLike(Buffer, "le", 2),
    ],
    protocolProgram
  );

  let transactionIxs: TransactionInstruction[] = [];

  const vaultStrategyAssetAta = await setupTokenAccount(
    connection,
    payer,
    vaultAssetMint,
    vaultStrategyAuth,
    transactionIxs,
    vaultAssetTokenProgram
  );

  const createInitializeStrategyIx = await vc.createInitializeStrategyIx(
    {},
    {
      payer,
      vault,
      manager: payer,
      strategy,
      remainingAccounts: [
        { pubkey: protocolProgram, isSigner: false, isWritable: false },
        { pubkey: userStats, isSigner: false, isWritable: true },
        { pubkey: state, isSigner: false, isWritable: true },
        { pubkey: user, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
    }
  );

  transactionIxs.push(createInitializeStrategyIx);

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    process.env.HELIUS_RPC_URL!,
    payerKp
  );
  console.log("Drift strategy initialized with signature:", txSig);

  if (useLookupTable) {
    const transactionIxs1: TransactionInstruction[] = [];

    await setupAddressLookupTable(
      connection,
      payer,
      payer,
      [
        ...new Set([
          ...createInitializeStrategyIx.keys.map((k) => k.pubkey.toBase58()),
          vaultStrategyAssetAta.toBase58(),
        ]),
      ],
      transactionIxs1,
      new PublicKey(lookupTableAddress)
    );

    const txSig1 = await sendAndConfirmOptimisedTx(
      transactionIxs1,
      process.env.HELIUS_RPC_URL!,
      payerKp,
      [],
      undefined,
      50_000
    );

    console.log("LUT updated with signature:", txSig1);
  }
};

const main = async () => {
  await initSolendStrategy(
    new PublicKey(PROTOCOL_CONSTANTS.SOLEND.PROGRAM_ID),
    new PublicKey(solendCounterpartyTa),
    new PublicKey(PROTOCOL_CONSTANTS.SOLEND.MAIN_MARKET.LENDING_MARKET),
    new PublicKey(solendCollateralMint)
  );
  await initMarginfiStrategy(
    new PublicKey(PROTOCOL_CONSTANTS.MARGINFI.PROGRAM_ID),
    new PublicKey(marginfiBank),
    new PublicKey(PROTOCOL_CONSTANTS.MARGINFI.MAIN_MARKET.GROUP)
  );
  await initKlendStrategy(
    new PublicKey(PROTOCOL_CONSTANTS.KLEND.PROGRAM_ID),
    new PublicKey(klendLendingMarket)
  );
  await initDriftStrategy(
    new PublicKey(PROTOCOL_CONSTANTS.DRIFT.PROGRAM_ID),
    new PublicKey(PROTOCOL_CONSTANTS.DRIFT.SPOT.STATE),
    new BN(driftMarketIndex),
    new BN(PROTOCOL_CONSTANTS.DRIFT.SUB_ACCOUNT_ID)
  );
};

main();
