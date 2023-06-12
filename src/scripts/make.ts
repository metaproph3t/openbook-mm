import * as os from 'os';
import * as fs from 'fs';
import {
  Keypair,
  Account,
  Commitment,
  Connection,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  BlockhashWithExpiryBlockHeight,
  TransactionInstruction,
} from '@solana/web3.js';
import {sleep} from '../utils/utils';
import BN from 'bn.js';
import {decodeEventQueue, DexInstructions, Market} from '@openbook-dex/openbook';
import {Logger} from 'tslog';
import axios from "axios";
import * as token from '@solana/spl-token';

const URL_MARKETS_BY_VOLUME = 'https://openserum.io/api/serum/markets.json?min24hVolume=';
const VOLUME_THRESHOLD = 1000;
const {
  ENDPOINT_URL,
  WALLET_PATH,
  KEYPAIR,
  PROGRAM_ID,
  INTERVAL,
  MAX_UNIQUE_ACCOUNTS,
  CONSUME_EVENTS_LIMIT,
  CLUSTER,
  PRIORITY_QUEUE_LIMIT, // queue length at which to apply the priority fee
  PRIORITY_CU_PRICE,    // extra microlamports per cu for high fee markets
  PRIORITY_CU_LIMIT,    // compute limit
  MAX_TX_INSTRUCTIONS,  // max instructions per transaction
  CU_PRICE,             // extra microlamports per cu for any transaction
  PRIORITY_MARKETS,     // input to add comma seperated list of markets that force fee bump
  MARKETS_FILE          // Specify the full path to an alternate markets.json file.
} = process.env;

// Read the alternate markets file if provided
const marketsFile = MARKETS_FILE || '../markets.json';
const markets = require(marketsFile);

const cluster = CLUSTER || 'mainnet';
const interval = INTERVAL || 2000;
const maxUniqueAccounts = parseInt(MAX_UNIQUE_ACCOUNTS || '10');
const consumeEventsLimit = new BN(CONSUME_EVENTS_LIMIT || '19');
const priorityMarkets = PRIORITY_MARKETS ? PRIORITY_MARKETS.split(',') : [] ;
const priorityQueueLimit = parseInt(PRIORITY_QUEUE_LIMIT || "100");
const cuPrice = parseInt(CU_PRICE || "0");
const priorityCuPrice = parseInt(PRIORITY_CU_PRICE || "100000");
const CuLimit = parseInt(PRIORITY_CU_LIMIT || "50000");
const maxTxInstructions = parseInt(MAX_TX_INSTRUCTIONS || "1");
const serumProgramId = new PublicKey(
  PROGRAM_ID || cluster == 'mainnet'
    ? 'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'
    : 'EoTcMgcDRTJVZDMZWBoU6rhYHZfkNTVEAfz3uUJRcYGj',
);
const walletFile = WALLET_PATH || os.homedir() + '/.config/solana/dev.json';
const maker = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      KEYPAIR || fs.readFileSync(walletFile, 'utf-8'),
    ),
  ),
);

const log: Logger = new Logger({name: "openbook-cranker", displayFunctionName: false, displayFilePath: "hidden", minLevel: "info"});

log.info(maker.publicKey.toString());

const connection = new Connection(ENDPOINT_URL!, 'processed' as Commitment);

// blockhash loop
let recentBlockhash: BlockhashWithExpiryBlockHeight;
try {
  connection.getLatestBlockhash(
    "finalized"
  ).then((blockhash) => {
    recentBlockhash = blockhash;
  });
}
catch (e) {
  log.error(`Couldn't get blockhash: ${e}`);
}
setInterval(async () => {
  try {
    recentBlockhash = await connection.getLatestBlockhash("finalized");
  } catch (e) {
    log.error(`Couldn't get blockhash: ${e}`);
  }
},1000)

async function run() {
  let makerAccount = new Account(maker.secretKey);
  // list of markets to make
  let marketsList = markets[cluster];

  let marketData = marketsList[0];
  const market = await Market.load(connection, new PublicKey(marketData.address), {}, serumProgramId);
  log.info("Making the following market:");
  log.info(`${marketData.name}: ${marketData.address}`);

  const base = market.baseMintAddress;
  const quote = market.quoteMintAddress; 

  const baseAcc = await token.getAssociatedTokenAddress(base, maker.publicKey);
  const quoteAcc = await token.getAssociatedTokenAddress(quote, maker.publicKey);


  while (true) {
    let bids = await market.loadBids(connection);
    let asks = await market.loadAsks(connection);

    // market price = average(highest bid, lowest ask)
    // maybe susceptible to manipulation?

    let [highestBidPrice] = bids.getL2(1)[0];
    let [highestAskPrice] = asks.getL2(1)[0];

    let marketPrice = (highestBidPrice + highestAskPrice) / 2;

    console.log(`${marketData.name}: ${marketPrice}`);

    // TODO: cancel any outstanding orders, then `settleFunds`

    let baseBalance = (await token.getAccount(connection, baseAcc)).amount;
    let quoteBalance = (await token.getAccount(connection, quoteAcc)).amount;

    log.info(`base balance: ${baseBalance}`);
    log.info(`quote balance: ${quoteBalance}`);

    let topBidAmt = quoteBalance / BigInt(10);
    let middleBidAmt = (quoteBalance * BigInt(25)) / BigInt(100);
    let bottomBidAmt = (quoteBalance * BigInt(65)) / BigInt(100);

    let bottomAskAmt = baseBalance / BigInt(10);
    let middleAskAmt = (baseBalance * BigInt(25)) / BigInt(100);
    let topAskAmt = (baseBalance * BigInt(65)) / BigInt(100);

    // TODO: spread adjustment logic

    let topBidPrice = marketPrice * 0.997
    let middleBidPrice = marketPrice * 0.994
    let bottomBidPrice = marketPrice * 0.991

    let bottomAskPrice = marketPrice * 1.003
    let middleAskPrice = marketPrice * 1.006
    let topAskPrice = marketPrice * 1.009

    // TODO: put these in instructions that are batched together in a single transaction

    await market.placeOrder(connection, {
      owner: makerAccount,
      payer: maker.publicKey,
      side: 'buy', // 'buy' or 'sell'
      price: topBidPrice,
      size: Number(topBidAmt),
      orderType: 'limit', // 'limit', 'ioc', 'postOnly'
    });

    await market.placeOrder(connection, {
      owner: makerAccount,
      payer: maker.publicKey,
      side: 'buy', // 'buy' or 'sell'
      price: middleBidPrice,
      size: Number(middleBidAmt),
      orderType: 'limit', // 'limit', 'ioc', 'postOnly'
    });

    await market.placeOrder(connection, {
      owner: makerAccount,
      payer: maker.publicKey,
      side: 'buy', // 'buy' or 'sell'
      price: bottomBidPrice,
      size: Number(bottomBidAmt),
      orderType: 'limit', // 'limit', 'ioc', 'postOnly'
    });

    await market.placeOrder(connection, {
      owner: makerAccount,
      payer: maker.publicKey,
      side: 'sell', // 'buy' or 'sell'
      price: bottomAskPrice,
      size: Number(bottomAskAmt),
      orderType: 'limit', // 'limit', 'ioc', 'postOnly'
    });

    await market.placeOrder(connection, {
      owner: makerAccount,
      payer: maker.publicKey,
      side: 'buy', // 'buy' or 'sell'
      price: middleAskPrice,
      size: Number(middleAskAmt),
      orderType: 'limit', // 'limit', 'ioc', 'postOnly'
    });

    await market.placeOrder(connection, {
      owner: makerAccount,
      payer: maker.publicKey,
      side: 'buy', // 'buy' or 'sell'
      price: topAskPrice,
      size: Number(topAskAmt),
      orderType: 'limit', // 'limit', 'ioc', 'postOnly'
    });

    await sleep(interval);
  }
}

run();
