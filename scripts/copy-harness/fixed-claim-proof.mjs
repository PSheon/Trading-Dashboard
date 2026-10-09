import { isDeepStrictEqual } from 'node:util';

// Production proof decoders are injected only after explicit runtime attestation.
export function createFixedClaimValidator(tools) {
 const names=["decodeLiveCopyMandate","liveCopySettingsDigest","canonicalLiveSourceLegs","decodeLiveSourceFill","liveSourceLegId","buildOrderAction","executionKey","intentFingerprint","decodeLiveSettlementProof","liveSourceExecutionCloid","parseFollowerFill","followerReceiptDigestV1"];
 if (!tools || names.some(name => typeof tools[name] !== 'function')) throw Error('Missing pinned proof decoder');
 const {decodeLiveCopyMandate,liveCopySettingsDigest,canonicalLiveSourceLegs,decodeLiveSourceFill,liveSourceLegId,buildOrderAction,executionKey,intentFingerprint,decodeLiveSettlementProof,liveSourceExecutionCloid,parseFollowerFill,followerReceiptDigestV1}=tools;

// Exact historical generation corroboration; no current grant or trading permit.
function originalAgentOwnerQuorum(binding, consent) {
 const {setup:s,wallet:w,account:a}=binding??{};
 if(!s||!w||!a||typeof w.privyOwnerId!=='string'||!w.privyOwnerId||typeof a.ownerQuorumId!=='string'||!a.ownerQuorumId)return null;
 for(const entity of [s,w,a])for(const field of ['userId','strategyId','network'])if(entity[field]!==consent[field])return null;
 if(a.id!==consent.accountId||a.address!==consent.accountAddress||a.privyUserId!==consent.ownerPrivyUserId||!a.privyWalletId||
 s.id!==consent.setupId||s.revision!==consent.setupRevision||s.accountId!==a.id||s.accountAddress!==a.address||s.accountWalletId!==a.privyWalletId||s.accountOwnerQuorumId!==a.ownerQuorumId||
 s.agentWalletId!==consent.agentWalletId||s.agentAddress!==consent.agentAddress||s.agentOwnerQuorumId!==w.privyOwnerId||s.authorizationId!==consent.authorizationId||s.policyId!==consent.policyId||s.policyFingerprint!==consent.policyFingerprint||s.workerQuorumId!==consent.workerQuorumId||
 w.id!==consent.executionWalletId||w.accountAddress!==a.address||w.privyWalletId!==consent.agentWalletId||w.signerAddress!==consent.agentAddress||w.privyOwnerId!==a.ownerQuorumId)return null;
 return w.privyOwnerId;
}
// Historical execution evidence only: no fetch, permits, timestamp rewriting or writes.
// Producer must supply an exact scoped SQL generation manifest and an independent
// SDK userFills read made on the declared network/account. HTTP input cannot
// attest this producer provenance. Immutable settlement replay uses the original
// assessment clock and its <=5s evidence fences; it mints no current authority.
function validateFixedClaimRefusal(input) {
    try {
        if (!input || Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024)
            return null;
        const { mandate: m, settings, candidate: d, generation: g, sdk } = input, consent = decodeLiveCopyMandate(m);
        const ownerQuorum=originalAgentOwnerQuorum(input.authorizationBinding,consent);if(!ownerQuorum)return null;
        if (settings.sizingMode !== 'fixed' || settings.copyStartMode !== 'delta' || liveCopySettingsDigest(settings) !== consent.settingsDigest || !m.consentDigest || !m.activationCursor)
            return null;
        const source = (raw) => decodeLiveSourceFill({ ...raw, providerTime: new Date(raw.providerTime), receivedAt: new Date(raw.receivedAt) });
        const current = source(input.fill), leg = canonicalLiveSourceLegs(current).find(l => l.leg === 'open');
        if (!leg || d.state !== 'refused' || d.reason !== 'fixed_trade_already_claimed' || d.leg !== 'open' || d.executionKey !== null ||
            d.mandateId !== m.id || d.userId !== consent.userId || d.strategyId !== consent.strategyId || d.accountId !== consent.accountId ||
            d.sourceFillId !== current.id || d.coin !== current.coin || d.leaderTime !== current.providerTime ||
            current.network !== consent.sourceNetwork || current.leaderAddress !== consent.leaderAddress || current.providerTime <= m.activationCursor.getTime() || current.providerTime > g.now || current.receivedAt > g.now)
            return null;
        for (const field of ['mandateId', 'accountId', 'userId', 'strategyId', 'network', 'accountAddress', 'authorizationId', 'settingsDigest', 'leaderAddress'])
            if (g.identity[field] !== consent[field])
                return null;
        if (g.identity.direction !== settings.direction || g.identity.mandateRevision !== m.revision || sdk.network !== consent.network || sdk.accountAddress !== consent.accountAddress || !Array.isArray(sdk.fills) || sdk.fills.length > 10000)
            return null;
        const entries = g.manifest.journals.filter((e) => e.leg?.mandateId === m.id && e.leg?.leg === 'open' && e.leg?.fixedTradeClaim === true && e.leg?.tradeKey === current.tradeKey && e.fill?.id !== current.id);
        if (entries.length !== 1)
            return null;
        const e = entries[0], original = source(e.fill), canonical = canonicalLiveSourceLegs(original).find(l => l.leg === 'open'), cloid = liveSourceExecutionCloid(m.id, original.id, 'open'), key = `${consent.network}:${consent.accountAddress}:${cloid}`;
        if (!canonical || original.network !== current.network || original.leaderAddress !== current.leaderAddress || original.streamId !== current.streamId || original.coin !== current.coin || original.tradeKey !== current.tradeKey || original.providerTime <= m.activationCursor.getTime() ||
            e.leg.id !== liveSourceLegId(m.id, original.id, 'open') || e.leg.state !== 'settled' || e.leg.executionKey !== key || e.journal.key !== key || e.journal.cloid !== cloid || !['filled', 'partial'].includes(e.journal.state) ||
            !e.reservation || e.reservation.state !== 'released' || e.reservation.releaseReason !== 'verified_settlement' || !e.evidence?.settlementProof || !e.evidence.settlementProofDigest)
            return null;
        if (!isDeepStrictEqual(canonical, { leg: e.leg.leg, tradeKey: e.leg.tradeKey, sign: e.leg.sign, size: e.leg.size, fraction: e.leg.fraction }))
            return null;
        const originalDispatch = input.originalDispatch;
        if (!originalDispatch || originalDispatch.id === d.id || originalDispatch.mandateId !== m.id || originalDispatch.userId !== consent.userId || originalDispatch.strategyId !== consent.strategyId || originalDispatch.accountId !== consent.accountId || originalDispatch.sourceFillId !== original.id || originalDispatch.coin !== original.coin || originalDispatch.leg !== 'open' || originalDispatch.state !== 'settled' || originalDispatch.executionKey !== key)
            return null;
        const proof = decodeLiveSettlementProof(e.evidence.settlementProof, e.evidence.settlementProofDigest), cert = proof.certificate;
        if (cert.key !== key || cert.accountId !== consent.accountId || cert.digest !== e.reservation.releaseEvidenceDigest || cert.digest !== e.evidence.settlementDigest || cert.oid !== e.reservation.exchangeOrderId || !cert.receipts.length)
            return null;
        const past = proof.input, j = e.journal, r = e.reservation, p = e.provenance, ev = e.evidence, record = j.record;
        const same = (a, b) => { if (!isDeepStrictEqual(a, b))
            throw Error('mirror'); }, ms = (v) => new Date(v).getTime();
        for (const entity of [j, r, ev])
            for (const field of ['userId', 'strategyId', 'network', 'accountAddress'])
                same(entity[field], consent[field]);
        for (const entity of [r, ev])
            same(entity.accountId, consent.accountId);
        if (p.mandateId !== m.id || p.legId !== e.leg.id || p.key !== key || p.sourceDigest !== original.sourceDigest || p.settingsDigest !== consent.settingsDigest || p.plannerVersion !== 1 || (!Number.isSafeInteger(p.mandateRevision) || p.mandateRevision < 1 || p.mandateRevision > g.identity.mandateRevision) || !/^([a-f0-9]{64})$/.test(p.sizingBasisDigest) || !Number.isSafeInteger(ms(p.admittedAt)))
            return null;
        if (record.key !== key || record.state !== j.state || record.updatedAt !== ms(j.updatedAt) || record.nonce !== j.nonce || record.authorization.id !== consent.authorizationId || record.authorization.version !== consent.authorizationVersion || record.authorization.walletId !== consent.agentWalletId || record.authorization.signerAddress !== consent.agentAddress || record.authorization.privyOwnerId !== ownerQuorum || record.authorization.userId !== consent.userId || record.authorization.strategyId !== consent.strategyId || record.authorization.network !== consent.network || record.authorization.accountAddress !== consent.accountAddress || record.authorization.signerAddress !== j.signerAddress)
            return null;
        const action = buildOrderAction(p.intent);
        same(action, record.action);
        if (executionKey(p.intent) !== key || intentFingerprint(p.intent, action) !== record.fingerprint || p.fingerprint !== record.fingerprint || p.intent.reduceOnly !== false || p.intent.market.coin !== original.coin || p.intent.side !== (canonical.sign * (settings.direction === 'reverse' ? -1 : 1) > 0 ? 'B' : 'A'))
            return null;
        for (const field of ['key', 'fingerprint', 'authorization', 'action', 'market', 'nonce', 'expiresAfter', 'createdAt'])
            same(record[field], past.record[field]);
        same(r.payload, past.reservation.payload);
        for (const field of ['key', 'accountId', 'userId', 'strategyId', 'network', 'accountAddress', 'fingerprint', 'walletId', 'authorizationId', 'strategyVersion', 'policyVersion', 'authorizationVersion', 'notionalUsd', 'marginUsd', 'feeBufferUsd', 'sourceDigest'])
            same(r[field], r.payload[field]);
        if (r.revision !== past.reservation.revision + 1 || ms(r.attemptedAt) !== past.reservation.attemptedAt || r.cloid !== cloid || r.coin !== p.intent.market.coin || r.asset !== p.intent.asset || r.dex !== p.intent.market.dex || ms(r.createdAt) !== r.payload.createdAt || ms(r.expiresAt) !== r.payload.expiresAt || ev.key !== key || ev.cloid !== cloid || ev.fingerprint !== record.fingerprint || ev.nonce !== record.nonce || past.accountId !== consent.accountId)
            return null;
        same(ev.settlementCertificate, cert);
        same(ev.statusObservation, past.evidence);
        same(ev.statusDigest, past.evidence.sourceDigest);
        same(ev.acknowledgement, past.acknowledgement);
        same(ev.acknowledgementDigest, past.acknowledgement?.responseDigest ?? null);
        const booked = g.manifest.receipts.filter((row) => row.executionKey === key);
        same(booked.map((row) => ({ key: row.key, digest: row.digest })).sort((a, b) => a.key.localeCompare(b.key)), [...cert.receipts].sort((a, b) => a.key.localeCompare(b.key)));
        if (booked.length !== past.receipts.rows.length)
            return null;
        for (const old of past.receipts.rows) {
            const row = booked.find((row) => row.key === old.key);
            if (!row)
                return null;
            for (const field of ['key', 'accountId', 'network', 'accountAddress', 'kind', 'sourceId', 'coin', 'digest', 'executionKey', 'attribution', 'record'])
                same(row[field], old[field]);
            same(ms(row.providerTime), old.providerTime);
            same(g.manifest.ledger.filter((l) => l.receiptKey === row.key).map(({ receiptKey, component, token, amount }) => ({ receiptKey, component, token, amount })).sort((a, b) => a.component.localeCompare(b.component)), old.ledger.map((l) => ({ ...l })).sort((a, b) => a.component.localeCompare(b.component)));
        }
        const actual = sdk.fills.filter((f) => typeof f?.cloid === 'string' && f.cloid.toLowerCase() === cloid);
        const receipts = actual.map((raw) => { const parsed = parseFollowerFill(raw, { network: sdk.network, accountAddress: sdk.accountAddress, coin: current.coin, oid: cert.oid }); if (parsed.side !== e.provenance.intent.side)
            throw Error('side'); return { key: parsed.key, digest: followerReceiptDigestV1(raw) }; });
        if (new Set(receipts.map((r) => r.key)).size !== receipts.length || !isDeepStrictEqual(receipts.sort((a, b) => a.key.localeCompare(b.key)), [...cert.receipts].sort((a, b) => a.key.localeCompare(b.key))))
            return null;
        return Object.freeze({ originalExecutionKey: key, originalLegId: e.leg.id, tradeKey: current.tradeKey });
    }
    catch {
        return null;
    }
}

 return validateFixedClaimRefusal;
}

const sqlQuote=value=>`'${String(value).replace(/'/g,"''")}'`;
/** One original claimed trade only, never cross-generation history scanning. */
export function fixedClaimEvidenceQuery(d,{network,leaderNetwork,leader,follower}) {
 if(d.reason!=='fixed_trade_already_claimed'||d.state!=='refused'||d.leg!=='open'||network!=='testnet'||leaderNetwork!=='testnet'||d.userId!==14||!d.id||!d.mandateId)return null;
 return `with target as (
 select m, v.settings, f, a, ag, w from copy_live_dispatches d
 join copy_live_mandates m on m.id=d.mandate_id
 join copy_strategy_versions v on v.strategy_id=m.strategy_id and v.version=m.strategy_version
 join copy_live_source_fills f on f.id=d.source_fill_id
 join copy_execution_accounts a on a.id=m.account_id and a.user_id=m.user_id and a.strategy_id=m.strategy_id and a.network=m.network and a.address=m.account_address and a.privy_user_id=m.owner_privy_user_id
 join copy_agent_setups ag on ag.id=m.setup_id and ag.revision=m.setup_revision and ag.user_id=m.user_id and ag.strategy_id=m.strategy_id and ag.network=m.network and ag.account_id=a.id and ag.account_address=a.address
 join copy_execution_wallets w on w.id=m.execution_wallet_id and w.user_id=m.user_id and w.strategy_id=m.strategy_id and w.network=m.network and w.account_address=a.address
 join users u on u.id=m.user_id and u.privy_user_id=m.owner_privy_user_id and u.embedded_wallet_address=m.owner_address
 where d.id=${sqlQuote(d.id)} and d.mandate_id=${sqlQuote(d.mandateId)} and d.source_fill_id=${sqlQuote(d.sourceFillId)}
 and d.user_id=m.user_id and d.strategy_id=m.strategy_id and d.account_id=m.account_id and m.user_id=14
 and m.network=${sqlQuote(network)} and m.source_network=${sqlQuote(leaderNetwork)} and m.leader_address=${sqlQuote(leader)} and m.account_address=${sqlQuote(follower)}
 and m.budget_usd='50' and d.state='refused' and d.reason='fixed_trade_already_claimed' and d.leg='open' and d.execution_key is null
 ), originals as (
 select l,j,p,s,r,e from target t
 join copy_live_signal_legs l on l.mandate_id=(t.m).id and l.trade_key=(t.f).trade_key and l.leg='open' and l.fixed_trade_claim and l.source_fill_id<>(t.f).id
 join copy_live_source_fills s on s.id=l.source_fill_id
 join copy_live_executions j on j.key=l.execution_key
 join copy_live_intent_provenance p on p.key=j.key and p.leg_id=l.id and p.mandate_id=l.mandate_id
 join copy_live_risk_reservations r on r.key=j.key
 join copy_live_execution_evidence e on e.key=j.key
 where j.network=${sqlQuote(network)} and j.account_address=${sqlQuote(follower)} and j.user_id=(t.m).user_id and j.strategy_id=(t.m).strategy_id
 and r.account_id=(t.m).account_id and e.account_id=(t.m).account_id
 limit 2
 ), data as (select jsonb_build_object('mandate',to_jsonb(t.m),'settings',t.settings,'fill',to_jsonb(t.f),
 'authorizationBinding',jsonb_build_object('setup',to_jsonb(t.ag),'wallet',to_jsonb(t.w),'account',to_jsonb(t.a)),
 'entries',(select coalesce(jsonb_agg(jsonb_build_object('leg',to_jsonb(o.l),'journal',to_jsonb(o.j),'provenance',to_jsonb(o.p),'fill',to_jsonb(o.s),'reservation',to_jsonb(o.r),'evidence',to_jsonb(o.e))),'[]'::jsonb) from originals o),
 'receipts',(select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) from (select x.* from copy_follower_receipts x join originals o on x.execution_key=(o.j).key where x.account_id=(t.m).account_id and x.network=${sqlQuote(network)} and x.account_address=${sqlQuote(follower)} limit 10001) q),
 'ledger',(select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) from (select x.receipt_key,x.component,x.amount::text as amount,x.token,x.created_at from copy_follower_ledger x join copy_follower_receipts c on c.key=x.receipt_key join originals o on c.execution_key=(o.j).key where c.account_id=(t.m).account_id and c.network=${sqlQuote(network)} and c.account_address=${sqlQuote(follower)} limit 30001) q)) value from target t)
 select case when octet_length(value::text)<=8388608 then value::text else 'EVIDENCE_TOO_LARGE' end from data`;
}
const camelRow=row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),value]));
export function hydrateFixedClaimEvidence(raw,{candidate,dispatches,network,accountAddress,fills,tools,now}) {
 if(typeof raw!=='string'||Buffer.byteLength(raw)>8*1024*1024)throw Error('Invalid bounded fixed claim evidence');
 const value=JSON.parse(raw),m=camelRow(value.mandate);
 for(const key of ['activationCursor','consentExpiresAt','expiresAt','createdAt','updatedAt'])if(m[key]!==null)m[key]=new Date(m[key]);
 if(!Array.isArray(value.entries)||value.entries.length!==1||!Array.isArray(value.receipts)||value.receipts.length>10000||!Array.isArray(value.ledger)||value.ledger.length>30000)throw Error('Incomplete fixed claim evidence');
 const entry=Object.fromEntries(Object.entries(value.entries[0]).map(([key,row])=>[key,camelRow(row)]));
 entry.provenance.sizingBasisDigest=tools.liveSourceDigest(entry.provenance.sizingBasis);
 const originalDispatch=dispatches.find(row=>row.mandateId===m.id&&row.sourceFillId===entry.fill.id&&row.executionKey===entry.journal.key);
 return {authorizationBinding:value.authorizationBinding?Object.fromEntries(Object.entries(value.authorizationBinding).map(([key,row])=>[key,camelRow(row)])):null,mandate:m,settings:value.settings,candidate,fill:camelRow(value.fill),originalDispatch,
 generation:{identity:{...m.intent,mandateRevision:m.revision,direction:value.settings.direction},now,manifest:{journals:[entry],receipts:value.receipts.map(camelRow),ledger:value.ledger.map(camelRow)}},
 sdk:{network,accountAddress,fills}};
}
