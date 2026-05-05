const sdk = require('@defillama/sdk');
const BigNumber = require('bignumber.js');
const { getUniqueAddresses } = require('@defillama/sdk/build/generalUtil');
const utils = require('../utils');
const { addMerklRewardApy } = require('../merkl/merkl-additional-reward');

const PROJECT = 'hyperswap-v3';
const CHAIN_RPC = 'hyperliquid';
const CHAIN_DISPLAY = 'hyperevm';
const FACTORY = '0xb1c0fa0b789320044a6f623cfe5ebda9562602e3';
// First PoolCreated emitted at block ~15337 (Feb 2025); use a small floor.
const FROM_BLOCK = 15000;
const BLOCK_TIME_SECONDS = 1;
const MIN_TVL_USD = 10000;
// App uses 'HYPE' alias in URL paths instead of WHYPE's address.
const WHYPE = '0x5555555555555555555555555555555555555555';
const tokenForUrl = (addr) => (addr.toLowerCase() === WHYPE ? 'HYPE' : addr);

const EVENTS = {
  PoolCreated:
    'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
  Swap:
    'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
};

async function getAllPools(toBlock) {
  const logs = await sdk.getEventLogs({
    chain: CHAIN_RPC,
    target: FACTORY,
    eventAbi: EVENTS.PoolCreated,
    fromBlock: FROM_BLOCK,
    toBlock,
  });
  const seen = new Set();
  const pools = [];
  for (const log of logs) {
    const address = log.args.pool.toLowerCase();
    if (seen.has(address)) continue;
    seen.add(address);
    pools.push({
      address,
      token0: log.args.token0.toLowerCase(),
      token1: log.args.token1.toLowerCase(),
      fee: BigInt(log.args.fee),
    });
  }
  return pools;
}

async function getTokenMetadata(addresses) {
  const [decimals, symbols] = await Promise.all([
    sdk.api.abi.multiCall({
      abi: 'erc20:decimals',
      calls: addresses.map((t) => ({ target: t })),
      chain: CHAIN_RPC,
      permitFailure: true,
    }),
    sdk.api.abi.multiCall({
      abi: 'erc20:symbol',
      calls: addresses.map((t) => ({ target: t })),
      chain: CHAIN_RPC,
      permitFailure: true,
    }),
  ]);

  const decimalsByAddr = Object.fromEntries(
    decimals.output.map((o) => [
      o.input.target.toLowerCase(),
      o.output != null ? Number(o.output) : null,
    ])
  );
  const symbolByAddr = Object.fromEntries(
    symbols.output.map((o) => [o.input.target.toLowerCase(), o.output])
  );
  return { decimalsByAddr, symbolByAddr };
}

async function getPoolBalances(pools) {
  const calls0 = pools.map((p) => ({ target: p.token0, params: [p.address] }));
  const calls1 = pools.map((p) => ({ target: p.token1, params: [p.address] }));
  const [bal0, bal1] = await Promise.all([
    sdk.api.abi.multiCall({
      abi: 'erc20:balanceOf',
      calls: calls0,
      chain: CHAIN_RPC,
      permitFailure: true,
    }),
    sdk.api.abi.multiCall({
      abi: 'erc20:balanceOf',
      calls: calls1,
      chain: CHAIN_RPC,
      permitFailure: true,
    }),
  ]);
  pools.forEach((p, i) => {
    p.balance0 = BigNumber(bal0.output[i]?.output || 0);
    p.balance1 = BigNumber(bal1.output[i]?.output || 0);
  });
}

async function getPricesChunked(addresses, chain) {
  const CHUNK = 100;
  const merged = { pricesByAddress: {}, pricesBySymbol: {} };
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = addresses.slice(i, i + CHUNK);
    const res = await utils.getPrices(chunk, chain);
    Object.assign(merged.pricesByAddress, res.pricesByAddress);
    Object.assign(merged.pricesBySymbol, res.pricesBySymbol);
  }
  return merged;
}

function tokenValueUsd(rawAmount, decimals, priceUsd) {
  if (!priceUsd || decimals == null) return BigNumber(0);
  return BigNumber(rawAmount.toString()).div(BigNumber(10).pow(decimals)).times(priceUsd);
}

async function getPoolDayStats(pool, fromBlock, toBlock, decimalsByAddr, pricesByAddress) {
  const dec0 = decimalsByAddr[pool.token0];
  const dec1 = decimalsByAddr[pool.token1];
  const price0 = pricesByAddress[pool.token0];
  const price1 = pricesByAddress[pool.token1];

  let swapLogs = [];
  try {
    swapLogs = await sdk.getEventLogs({
      chain: CHAIN_RPC,
      target: pool.address,
      eventAbi: EVENTS.Swap,
      fromBlock,
      toBlock,
    });
  } catch (e) {
    console.warn(`Swap log fetch failed for ${pool.address}: ${e.message}`);
    return { volumeUsd1d: NaN, feesUsd1d: NaN };
  }

  let volume0In = 0n;
  let volume1In = 0n;
  for (const log of swapLogs) {
    const a0 = BigInt(log.args.amount0);
    const a1 = BigInt(log.args.amount1);
    if (a0 > 0n) volume0In += a0;
    if (a1 > 0n) volume1In += a1;
  }

  const volumeUsd0 = tokenValueUsd(volume0In, dec0, price0);
  const volumeUsd1 = tokenValueUsd(volume1In, dec1, price1);
  const volumeUsd1d = volumeUsd0.plus(volumeUsd1).toNumber();

  const feeRate = Number(pool.fee) / 1e6;
  const feesUsd1d = volumeUsd1d * feeRate;

  return { volumeUsd1d, feesUsd1d };
}

async function apy() {
  const latestBlock = await sdk.api.util.getLatestBlock(CHAIN_RPC);
  const toBlock = latestBlock.number;
  const fromBlock24h = toBlock - Math.floor((24 * 3600) / BLOCK_TIME_SECONDS);

  const allPools = await getAllPools(toBlock);

  const tokenAddresses = getUniqueAddresses(
    allPools.flatMap((p) => [p.token0, p.token1])
  );

  const [{ decimalsByAddr, symbolByAddr }, prices] = await Promise.all([
    getTokenMetadata(tokenAddresses),
    getPricesChunked(tokenAddresses, CHAIN_RPC),
  ]);

  await getPoolBalances(allPools);

  const enriched = allPools
    .map((p) => {
      const dec0 = decimalsByAddr[p.token0];
      const dec1 = decimalsByAddr[p.token1];
      const price0 = prices.pricesByAddress[p.token0];
      const price1 = prices.pricesByAddress[p.token1];
      if (dec0 == null || dec1 == null || !price0 || !price1) return null;

      const tvl0 = tokenValueUsd(BigInt(p.balance0.toFixed(0)), dec0, price0);
      const tvl1 = tokenValueUsd(BigInt(p.balance1.toFixed(0)), dec1, price1);
      const tvlUsd = tvl0.plus(tvl1).toNumber();
      if (!Number.isFinite(tvlUsd) || tvlUsd < MIN_TVL_USD) return null;

      return { ...p, tvlUsd };
    })
    .filter(Boolean);

  const withDayStats = await sdk.util.runInPromisePool({
    items: enriched,
    concurrency: 5,
    processor: async (pool) => {
      const { volumeUsd1d, feesUsd1d } = await getPoolDayStats(
        pool,
        fromBlock24h,
        toBlock,
        decimalsByAddr,
        prices.pricesByAddress
      );
      // tvlUsd is guaranteed >= MIN_TVL_USD by the filter above; if feesUsd1d is NaN
      // (swap-log fetch failed), apyBase stays NaN and utils.keepFinite drops the pool.
      const apyBase = (feesUsd1d * 365) / pool.tvlUsd * 100;
      const feePercent = Number(pool.fee) / 10000;

      return {
        pool: pool.address,
        chain: utils.formatChain(CHAIN_DISPLAY),
        project: PROJECT,
        symbol: utils.formatSymbol(
          `${symbolByAddr[pool.token0] || '?'}-${symbolByAddr[pool.token1] || '?'}`
        ),
        tvlUsd: pool.tvlUsd,
        apyBase,
        underlyingTokens: [pool.token0, pool.token1],
        poolMeta: `${feePercent}%`,
        url: `https://app.hyperswap.exchange/#/add/${tokenForUrl(pool.token0)}/${tokenForUrl(pool.token1)}/${pool.fee}`,
        volumeUsd1d,
      };
    },
  });

  const withRewards = await addMerklRewardApy(withDayStats, 'hyperswap');
  return withRewards.filter((p) => utils.keepFinite(p));
}

module.exports = {
  timetravel: false,
  apy,
  url: 'https://app.hyperswap.exchange',
};
