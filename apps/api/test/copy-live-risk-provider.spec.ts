import { describe, expect, it, vi } from 'vitest';
import { HyperliquidLiveRiskProvider } from '../src/copy/live/live-risk-provider.js';
import type { LiveMarketIdentity } from '../src/copy/live/live-market-resolver.js';

const user = `0x${'22'.repeat(20)}`,
  at = 1_790_000_000_000;
const market: LiveMarketIdentity = {
  network: 'testnet',
  coin: 'BTC',
  dex: '',
  asset: 0,
  universeIndex: 0,
  perpDexIndex: 0,
  sizeDecimals: 5,
  maxLeverage: 40,
  observedAt: at,
};
const options = {
  extraRiskBufferBps: '0.5',
  restingOrderBuilderFeeCapTenthsBps: 100,
};
function setup(
  change?: (body: Record<string, unknown>, value: unknown) => unknown,
) {
  let clock = at;
  const requests: Record<string, unknown>[] = [],
    acquire = vi.fn(async (_weight: number) => {});
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe('https://api.hyperliquid-testnet.xyz/info');
    expect(init?.redirect).toBe('error');
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    let value: unknown;
    switch (body.type) {
      case 'userRole':
        value = { role: 'user' };
        break;
      case 'userAbstraction':
        value = 'disabled';
        break;
      case 'userDexAbstraction':
        value = false;
        break;
      case 'spotClearinghouseState':
        value = { portfolioMarginEnabled: false, balances: [] };
        break;
      case 'perpDexs':
        value = [null, { name: 'xyz' }];
        break;
      case 'spotMeta':
        value = { tokens: [{ index: 7, name: 'USDC', isCanonical: true }] };
        break;
      case 'metaAndAssetCtxs':
        value = [
          {
            collateralToken: 7,
            universe: [
              {
                name: body.dex ? 'xyz:BTC' : 'BTC',
                szDecimals: 5,
                maxLeverage: 40,
              },
            ],
          },
          [{ midPx: '65000', markPx: '65001' }],
        ];
        break;
      case 'activeAssetData':
        value = {
          user,
          coin: body.coin,
          leverage: { type: 'cross', value: 3 },
          markPx: '65001',
          maxTradeSzs: ['0', '0'],
          availableToTrade: ['0', '0'],
        };
        break;
      case 'userFees':
        value = {
          userAddRate: '-0.00001',
          userCrossRate: '0.00045',
          activeReferralDiscount: '0.04',
          trial: null,
        };
        break;
      default:
        throw new Error('unexpected read');
    }
    return new Response(JSON.stringify(change ? change(body, value) : value));
  });
  const provider = new HyperliquidLiveRiskProvider(
    'testnet',
    acquire,
    fetcher,
    () => clock,
  );
  return {
    provider,
    fetcher,
    acquire,
    requests,
    setClock: (value: number) => {
      clock = value;
    },
  };
}
describe('authoritative testnet risk provider', () => {
  it('reads real configured leverage at zero position and exact signed fractional fees', async () => {
    const s = setup(),
      proof = await s.provider.observe(user, market, options);
    expect(proof).toMatchObject({
      network: 'testnet',
      accountAddress: user,
      coin: 'BTC',
      dex: '',
      asset: 0,
      earliestObservedAt: at,
      completedAt: at,
      accountModeProof: {
        role: 'user',
        accountAbstraction: 'disabled',
        dexAbstraction: false,
        portfolioMargin: false,
      },
      quote: { market, midPrice: '65000', markPrice: '65001', observedAt: at },
      leverageProofs: [
        {
          network: 'testnet',
          accountAddress: user,
          coin: 'BTC',
          dex: '',
          asset: 0,
          type: 'cross',
          value: 3,
          observedAt: at,
        },
      ],
      fees: {
        network: 'testnet',
        accountAddress: user,
        dex: '',
        makerFeeBps: '-0.1',
        takerFeeBps: '4.32',
        ...options,
      },
    });
    expect(proof.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(proof.fees)).toBe(true);
    expect(Object.isFrozen(proof.market)).toBe(true);
    expect(
      s.requests.some(
        (r) =>
          r.type === 'activeAssetData' && r.user === user && r.coin === 'BTC',
      ),
    ).toBe(true);
    expect(s.requests.some((r) => r.type === 'clearinghouseState')).toBe(false);
    // The thirteen reads' weight (304) in one reservation, before the clock.
    expect(s.acquire.mock.calls).toEqual([[304]]); expect(s.requests).toHaveLength(13);
  });
  it('applies referral discount to positive maker rates exactly once', async () => {
    const s = setup((b, v) =>
      b.type === 'userFees' ? { ...(v as object), userAddRate: '0.00015' } : v,
    );
    expect(
      (await s.provider.observe(user, market, options)).fees,
    ).toMatchObject({ makerFeeBps: '1.44', takerFeeBps: '4.32' });
  });
  it('accepts a valid target even when another listed market has no mid price', async () => {
    const s = setup((b, v) =>
      b.type === 'metaAndAssetCtxs'
        ? [
            {
              collateralToken: 7,
              universe: [
                { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
                { name: 'ETH', szDecimals: 4, maxLeverage: 40 },
              ],
            },
            [
              { midPx: '65000', markPx: '65001' },
              { midPx: null, markPx: '1' },
            ],
          ]
        : v,
    );
    expect(
      (await s.provider.observe(user, market, options)).quote.midPrice,
    ).toBe('65000');
  });
  it('validates actual isolated configuration without assuming market maximum', async () => {
    const s = setup((b, v) =>
      b.type === 'activeAssetData'
        ? {
            ...(v as object),
            leverage: { type: 'isolated', value: 7, rawUsd: '-1.5' },
          }
        : v,
    );
    expect(
      (await s.provider.observe(user, market, options)).leverageProofs[0],
    ).toMatchObject({ type: 'isolated', value: 7 });
  });
  it('refuses null active data instead of inventing zero-position leverage', async () => {
    await expect(
      setup((b, v) =>
        b.type === 'activeAssetData' ? null : v,
      ).provider.observe(user, market, options),
    ).rejects.toThrow('live_risk_provider_invalid_evidence');
  });
  it.each([
    { user: `0x${'33'.repeat(20)}` },
    { network: 'mainnet' },
    { dex: 'xyz' },
  ])('refuses wrong-source fees %j', async (patch) => {
    await expect(
      setup((b, v) =>
        b.type === 'userFees' ? { ...(v as object), ...patch } : v,
      ).provider.observe(user, market, options),
    ).rejects.toThrow('live_risk_provider_source_mismatch');
  });
  it('rejects mainnet input and closed producers', async () => {
    const s = setup();
    await expect(
      s.provider.observe(user, { ...market, network: 'mainnet' }, options),
    ).rejects.toThrow('live_risk_provider_source_mismatch');
    s.provider.close();
    await expect(s.provider.observe(user, market, options)).rejects.toThrow(
      'live_risk_provider_unavailable',
    );
  });
  it('rejects duplicate venue names and shifted duplicate market rows', async () => {
    await expect(
      setup((b, v) =>
        b.type === 'perpDexs' ? [null, { name: 'xyz' }, { name: 'xyz' }] : v,
      ).provider.observe(user, market, options),
    ).rejects.toThrow();
    await expect(
      setup((b, v) =>
        b.type === 'metaAndAssetCtxs'
          ? [
              {
                collateralToken: 7,
                universe: [
                  { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
                  { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
                ],
              },
              [
                { midPx: '1', markPx: '1' },
                { midPx: '1', markPx: '1' },
              ],
            ]
          : v,
      ).provider.observe(user, market, options),
    ).rejects.toThrow();
  });
  it.each([
    { leverage: undefined },
    { leverage: { type: 'cross', value: 0 } },
    { leverage: { type: 'cross', value: 41 } },
    { leverage: { type: 'isolated', value: 3 } },
    { leverage: { type: 'cross', value: '3' } },
    { coin: 'ETH' },
    { user: `0x${'33'.repeat(20)}` },
    { markPx: null },
    { availableToTrade: ['0'] },
    { maxTradeSzs: ['0', '-1'] },
  ])(
    'refuses missing or mismatched active-asset evidence %j',
    async (patch) => {
      await expect(
        setup((b, v) =>
          b.type === 'activeAssetData' ? { ...(v as object), ...patch } : v,
        ).provider.observe(user, market, options),
      ).rejects.toThrow();
    },
  );
  it.each([
    { userAddRate: undefined },
    { userAddRate: '1e-5' },
    { userCrossRate: '-0.0001' },
    { activeReferralDiscount: '1.1' },
    { activeReferralDiscount: undefined },
    { trial: { rate: '0' } },
    { userAddRate: ['0.001'] },
  ])('refuses malformed or unresolved effective fees %j', async (patch) => {
    await expect(
      setup((b, v) =>
        b.type === 'userFees' ? { ...(v as object), ...patch } : v,
      ).provider.observe(user, market, options),
    ).rejects.toThrow();
  });
  it('fails closed on named-dex fees whose deployer/alignment scope is unproven', async () => {
    const named = {
      ...market,
      coin: 'xyz:BTC',
      dex: 'xyz',
      asset: 110000,
      perpDexIndex: 1,
    };
    const s = setup();
    await expect(
      s.provider.observe(user, named, options),
    ).rejects.toThrow('live_risk_provider_fee_scope_unproven');
    // Refused before any weight is taken.
    expect(s.acquire).not.toHaveBeenCalled(); expect(s.requests).toHaveLength(0);
  });
  it.each(['agent', 'vault', 'subAccount', 'missing'])(
    'refuses non-user role %s',
    async (role) => {
      await expect(
        setup((b, v) =>
          b.type === 'userRole' ? { role } : v,
        ).provider.observe(user, market, options),
      ).rejects.toThrow();
    },
  );
  it.each(['default', 'unifiedAccount', 'portfolioMargin', null])(
    'refuses unresolved account abstraction %s',
    async (mode) => {
      await expect(
        setup((b, v) =>
          b.type === 'userAbstraction' ? mode : v,
        ).provider.observe(user, market, options),
      ).rejects.toThrow();
    },
  );
  it('refuses a late account mode change', async () => {
    let calls = 0;
    await expect(
      setup((b, v) =>
        b.type === 'userDexAbstraction' && ++calls === 2 ? true : v,
      ).provider.observe(user, market, options),
    ).rejects.toThrow();
  });
  it.each([{ midPx: null }, { markPx: '0' }, { midPx: '1e5' }])(
    'refuses missing or invalid quote %j',
    async (patch) => {
      await expect(
        setup((b, v) =>
          b.type === 'metaAndAssetCtxs'
            ? [
                ...(v as unknown[]).slice(0, 1),
                [{ midPx: '65000', markPx: '65001', ...patch }],
              ]
            : v,
        ).provider.observe(user, market, options),
      ).rejects.toThrow();
    },
  );
  it('binds exact metadata index, decimals, leverage and canonical collateral', async () => {
    for (const replacement of [
      [
        {
          collateralToken: 7,
          universe: [{ name: 'ETH', szDecimals: 5, maxLeverage: 40 }],
        },
        [{ midPx: '1', markPx: '1' }],
      ],
      [
        {
          collateralToken: 7,
          universe: [{ name: 'BTC', szDecimals: 4, maxLeverage: 40 }],
        },
        [{ midPx: '1', markPx: '1' }],
      ],
      [
        {
          collateralToken: 7,
          universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 20 }],
        },
        [{ midPx: '1', markPx: '1' }],
      ],
      [
        {
          collateralToken: 9,
          universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }],
        },
        [{ midPx: '1', markPx: '1' }],
      ],
      [
        {
          collateralToken: 7,
          universe: [
            { name: 'BTC', szDecimals: 5, maxLeverage: 40, isDelisted: true },
          ],
        },
        [{ midPx: '1', markPx: '1' }],
      ],
    ])
      await expect(
        setup((b, v) =>
          b.type === 'metaAndAssetCtxs' ? replacement : v,
        ).provider.observe(user, market, options),
      ).rejects.toThrow();
  });
  it('never returns a cached result after a revoked leverage or unavailable read', async () => {
    let deny = false;
    const s = setup((b, v) =>
      deny && b.type === 'activeAssetData' ? null : v,
    );
    await s.provider.observe(user, market, options);
    deny = true;
    await expect(s.provider.observe(user, market, options)).rejects.toThrow();
  });
  it('retains earliest market evidence and rejects expired observations', async () => {
    const s = setup();
    const proof = await s.provider.observe(
      user,
      { ...market, observedAt: at - 1000 },
      options,
    );
    expect(proof.earliestObservedAt).toBe(at - 1000);
    s.setClock(at + 5001);
    await expect(s.provider.observe(user, market, options)).rejects.toThrow(
      'live_risk_provider_stale',
    );
  });
  it('fails after read delay expires earlier evidence', async () => {
    const s = setup((b, v) => {
      if (b.type === 'activeAssetData') s.setClock(at + 5001);
      return v;
    });
    await expect(s.provider.observe(user, market, options)).rejects.toThrow(
      'live_risk_provider_stale',
    );
  });
  it('captures caller market and buffer inputs before asynchronous budget waits', async () => {
    const s = setup(),
      mutable = { ...market },
      buffers = { ...options };
    let release!: () => void;
    s.acquire.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = s.provider.observe(user, mutable, buffers);
    void pending.catch(() => {});
    mutable.coin = 'ETH';
    buffers.extraRiskBufferBps = '0';
    expect(release).toBeTypeOf('function');
    release();
    expect(await pending).toMatchObject({
      coin: 'BTC',
      fees: { extraRiskBufferBps: '0.5' },
    });
  });
  it('bounds pending shared budgets and redacts provider failures', async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      s.acquire.mockImplementation(() => new Promise(() => {}));
      const pending = expect(
        s.provider.observe(user, market, { ...options, timeoutMs: 30 }),
      ).rejects.toThrow('live_risk_provider_unavailable');
      void pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(31);
      await pending;
    } finally {
      vi.useRealTimers();
    }
    const s = setup();
    s.fetcher.mockRejectedValue(new Error('private_provider_body'));
    await expect(s.provider.observe(user, market, options)).rejects.toThrow(
      'live_risk_provider_unavailable',
    );
  });
  it.each([
    { extraRiskBufferBps: undefined },
    { extraRiskBufferBps: '-1' },
    { restingOrderBuilderFeeCapTenthsBps: undefined },
    { restingOrderBuilderFeeCapTenthsBps: 101 },
  ])('requires explicit conservative buffers %j', async (patch) => {
    await expect(
      setup().provider.observe(user, market, {
        ...options,
        ...patch,
      } as typeof options),
    ).rejects.toThrow();
  });
});
