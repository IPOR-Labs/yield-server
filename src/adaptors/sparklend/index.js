// Copied from aave v3
const axios = require('axios');
const sdk = require('@defillama/sdk');

const utils = require('../utils');
const { aTokenAbi } = require('../aave-v3/abi');
const poolAbi = require('../aave-v3/poolAbi');
const abiSKYFarm = require('./abiSKYFarm.json');

const sparkChains = ['ethereum', 'gnosis'];

/**
 * protocol data provider address per chain
 * @type {{ethereum: string, gnosis: string}}
 */
const protocolDataProviderAddress = {
  ethereum: '0xFc21d6d146E6086B8359705C8b28512a983db0cb',
  gnosis: '0x2a002054A06546bB5a264D57A81347e23Af91D18',
};

/**
 * Fetches the Spark V3 pools
 * @param {('ethereum'|'gnosis')} chain
 */
async function fetchV3Pools(chain) {
  const target = protocolDataProviderAddress[chain];

  chain = chain === 'gnosis' ? 'xdai' : chain; // llamas sdk uses xdai instead of gnosis

  const reserveTokens = (
    await sdk.api.abi.call({
      target,
      abi: poolAbi.find((m) => m.name === 'getAllReservesTokens'),
      chain,
    })
  ).output;

  const aTokens = (
    await sdk.api.abi.call({
      target,
      abi: poolAbi.find((m) => m.name === 'getAllATokens'),
      chain,
    })
  ).output;

  const poolsReserveData = (
    await sdk.api.abi.multiCall({
      calls: reserveTokens.map((p) => ({
        target,
        params: p.tokenAddress,
      })),
      abi: poolAbi.find((m) => m.name === 'getReserveData'),
      chain,
    })
  ).output.map((o) => o.output);

  const poolsReservesConfigurationData = (
    await sdk.api.abi.multiCall({
      calls: reserveTokens.map((p) => ({
        target,
        params: p.tokenAddress,
      })),
      abi: poolAbi.find((m) => m.name === 'getReserveConfigurationData'),
      chain,
    })
  ).output.map((o) => o.output);

  const totalSupplyEthereum = (
    await sdk.api.abi.multiCall({
      chain,
      abi: aTokenAbi.find(({ name }) => name === 'totalSupply'),
      calls: aTokens.map((t) => ({
        target: t.tokenAddress,
      })),
    })
  ).output.map((o) => o.output);

  const underlyingBalancesEthereum = (
    await sdk.api.abi.multiCall({
      chain,
      abi: aTokenAbi.find(({ name }) => name === 'balanceOf'),
      calls: aTokens.map((t, i) => ({
        target: reserveTokens[i].tokenAddress,
        params: [t.tokenAddress],
      })),
    })
  ).output.map((o) => o.output);

  const underlyingDecimalsEthereum = (
    await sdk.api.abi.multiCall({
      chain,
      abi: aTokenAbi.find(({ name }) => name === 'decimals'),
      calls: aTokens.map((t) => ({
        target: t.tokenAddress,
      })),
    })
  ).output.map((o) => o.output);

  const priceKeys = reserveTokens
    .map((t) => `${chain}:${t.tokenAddress}`)
    .join(',');
  const pricesEthereum = (
    await axios.get(`https://coins.llama.fi/prices/current/${priceKeys}`)
  ).data.coins;

  return reserveTokens
    .map((pool, i) => {
      const p = poolsReserveData[i];
      const price = pricesEthereum[`${chain}:${pool.tokenAddress}`]?.price;

      const supply = totalSupplyEthereum[i];
      const totalSupplyUsd =
        (supply / 10 ** underlyingDecimalsEthereum[i]) * price;

      const currentSupply = underlyingBalancesEthereum[i];
      const tvlUsd =
        (currentSupply / 10 ** underlyingDecimalsEthereum[i]) * price;

      return {
        pool: `${aTokens[i].tokenAddress}-${chain}`.toLowerCase(),
        // Captialize the first letter of the chain
        chain: chain === 'xdai' ? 'Gnosis' : 'Ethereum',
        project: 'sparklend',
        symbol: pool.symbol,
        tvlUsd,
        apyBase: (p.liquidityRate / 10 ** 27) * 100,
        underlyingTokens: [pool.tokenAddress],
        totalSupplyUsd,
        totalBorrowUsd: totalSupplyUsd - tvlUsd,
        apyBaseBorrow: Number(p.variableBorrowRate) / 1e25,
        ltv: poolsReservesConfigurationData[i].ltv / 10000,
        borrowable: poolsReservesConfigurationData[i].borrowingEnabled,
      };
    })
    .filter((p) => utils.keepFinite(p));
}

const skyFarm = async () => {
  const stakingRewards = '0x0650CAF159C5A49f711e8169D4336ECB9b950275';
  const USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F';
  const SKY = '0x56072C95FAA701256059aa122697B133aDEd9279';

  const totalSupply =
    (
      await sdk.api.abi.call({
        target: stakingRewards,
        abi: 'erc20:totalSupply',
      })
    ).output / 1e18;

  const stakingToken = (
    await sdk.api.abi.call({
      target: stakingRewards,
      abi: abiSKYFarm.find((m) => m.name === 'stakingToken'),
    })
  ).output;

  const prices = await axios.get(
    `https://coins.llama.fi/prices/current/${[USDS, SKY]
      .map((i) => `ethereum:${i}`)
      .join(',')}`
  );

  const priceUSDS = prices.data.coins[`ethereum:${USDS}`].price;
  const priceSKY = prices.data.coins[`ethereum:${SKY}`].price;

  const tvlUsd = totalSupply * priceUSDS;

  const rewardRate =
    (
      await sdk.api.abi.call({
        target: stakingRewards,
        abi: abiSKYFarm.find((m) => m.name === 'rewardRate'),
      })
    ).output / 1e18;

  const secPerDay = 86400;
  const apyReward = ((rewardRate * secPerDay * 365 * priceSKY) / tvlUsd) * 100;

  return [
    {
      pool: stakingRewards,
      chain: 'Ethereum',
      project: 'sparklend',
      symbol: 'USDS',
      poolMeta: 'SKY Farming Pool',
      tvlUsd: totalSupply * priceUSDS,
      apyReward,
      underlyingTokens: [stakingToken],
      rewardTokens: [SKY],
    },
  ];
};

const apy = async () => {
  const skyFarmPool = await skyFarm();

  const v3Pools = [
    ...(await Promise.all(sparkChains.map(fetchV3Pools))),
  ].flat();

  const ilk = (
    await sdk.api.abi.call({
      target: '0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B',
      params: [
        '0x4449524543542d535041524b2d44414900000000000000000000000000000000',
      ],
      abi: {
        constant: true,
        inputs: [{ internalType: 'bytes32', name: '', type: 'bytes32' }],
        name: 'ilks',
        outputs: [
          { internalType: 'uint256', name: 'Art', type: 'uint256' },
          { internalType: 'uint256', name: 'rate', type: 'uint256' },
          { internalType: 'uint256', name: 'spot', type: 'uint256' },
          { internalType: 'uint256', name: 'line', type: 'uint256' },
          { internalType: 'uint256', name: 'dust', type: 'uint256' },
        ],
        payable: false,
        stateMutability: 'view',
        type: 'function',
      },
    })
  ).output;

  const ethereumDaiPool = v3Pools.find(
    (p) => p.symbol === 'DAI' && p.chain === 'Ethereum'
  );
  ethereumDaiPool.totalSupplyUsd = Number(ilk.line) / 1e45;
  ethereumDaiPool.tvlUsd =
    ethereumDaiPool.totalSupplyUsd - ethereumDaiPool.totalBorrowUsd;

  return [...v3Pools, ...skyFarmPool];
};

module.exports = {
  timetravel: false,
  apy: apy,
  url: 'https://app.spark.fi/markets/',
};
