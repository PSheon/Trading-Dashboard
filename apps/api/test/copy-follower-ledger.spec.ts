import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { copyExecutionAccounts, copyExecutionWallets, copyWalletAuthorizations, copyLiveExecutionEvidence, copyStrategies, copyLiveExecutions, copyFollowerReceipts, copyFollowerLedger,
  copyFollowerAccountState, copyFollowerReceiptConflicts, copyPaperFills, users } from "@trading-dashboard/shared/database";
import { buildOrderAction, executionKey, intentFingerprint, type LiveOrderIntent } from '../src/copy/live/live-order.js';
import { captureLiveOrderIdentity, parseLiveOrderEvidence, parseLiveIocAcknowledgement } from '../src/copy/live/live-order-evidence.js';
import type { LiveExecutionRecord } from '../src/copy/live/live-execution.js';
import { CopyFollowerLedger } from "../src/copy/live/copy-follower-ledger.js";
import { CopyFollowerStatementRepository } from "../src/copy/copy-follower-statement.repository.js";
import { CopyFollowerStatementService } from "../src/copy/copy-follower-statement.service.js";
import { copyFollowerStatementSchema } from "@trading-dashboard/shared/contracts";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { getTestDb, closeTestDb, truncateAll, insertUser, type TestDb } from "./db-test-utils.js";

let db: TestDb, uid: number, strategyId: number, ledger: CopyFollowerLedger;
const accountId = "follower", accountAddress = `0x${"11".repeat(20)}`;
function fill(overrides: Record<string, unknown> = {}) { return { coin: "BTC", tid: 1, oid: 7, side: "B", time: Date.now() - 1000,
  px: "20000", sz: "0.01", closedPnl: "2", fee: "0.06", builderFee: "0.02", feeToken: "USDC", ...overrides }; }
async function execution(coin = 'BTC', cloidByte = '33', ageMs = 2000) {
  const createdAt = Date.now() - ageMs, market = { network:'testnet' as const,coin,dex:'',asset:0,universeIndex:0,perpDexIndex:0,sizeDecimals:5,maxLeverage:20,observedAt:createdAt };
  const intent:LiveOrderIntent = { authorizationId:'grant',userId:uid,strategyId,walletId:'agent',network:'testnet' as const,accountAddress:accountAddress as `0x${string}`,reduceOnly:false,
    cloid:`0x${cloidByte.repeat(16)}`,asset:0,side:'B' as const,size:'0.01',limitPrice:'20000',sizeDecimals:5,timeInForce:'Ioc' as const,market };
  const action = buildOrderAction(intent), key = executionKey(intent), fingerprint = intentFingerprint(intent,action);
  const record:LiveExecutionRecord = {key,fingerprint,market,action,nonce:createdAt,expiresAfter:createdAt+60000,state:'partial',createdAt,updatedAt:createdAt,
    authorization:{id:'grant',version:1,userId:uid,strategyId,walletId:'agent',privyOwnerId:'agent-owner',signerAddress:`0x${'22'.repeat(20)}`,accountAddress:intent.accountAddress,
      network:'testnet',scopes:['copy:trade'],validFrom:createdAt-1,expiresAt:createdAt+60000,revokedAt:null,exchangeApprovedAt:createdAt-1},outcome:{state:'partial',exchangeOrderId:'7'}};
  await db.insert(copyLiveExecutions).values({key,network:'testnet',accountAddress,signerAddress:record.authorization.signerAddress,cloid:intent.cloid,nonce:record.nonce,
    userId:uid,strategyId,state:record.state,updatedAt:new Date(record.updatedAt),record:record as unknown as Record<string,unknown>});
  return record;
}
async function evidenceOnly(ageMs = 2000) {
  const record = await execution('BTC','33',ageMs); delete record.outcome; record.state='unknown';
  await db.update(copyLiveExecutions).set({state:record.state,record:record as unknown as Record<string,unknown>}).where(eq(copyLiveExecutions.key,record.key));
  const acknowledgement = parseLiveIocAcknowledgement({identity:captureLiveOrderIdentity(record,record.market!),checkedAt:record.createdAt+1500,
    raw:{status:'ok',response:{type:'order',data:{statuses:[{filled:{oid:7,totalSz:'0.005',avgPx:'20000'}}]}}}});
  await db.insert(copyLiveExecutionEvidence).values({key:record.key,accountId,userId:uid,strategyId,network:'testnet',accountAddress,cloid:record.action.orders[0].c,
    fingerprint:record.fingerprint,nonce:record.nonce,exchangeOrderId:'7',acknowledgement:acknowledgement as unknown as Record<string,unknown>,acknowledgementDigest:acknowledgement.responseDigest,
    createdAt:new Date(),updatedAt:new Date()});
  return {record,acknowledgement};
}
beforeAll(() => { db = getTestDb(); ledger = new CopyFollowerLedger(db, new UnitOfWork(db)); });
beforeEach(async () => {
  await truncateAll(db); uid = (await insertUser(db, { privyUserId: "did:privy:follower" })).id;
  strategyId = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: `0x${"55".repeat(20)}`, allocated: "100", cash: "100", activatedAt: new Date() }).returning())[0].id;
  await db.insert(copyExecutionWallets).values({ id:'local-agent',userId:uid,strategyId,network:'testnet',accountAddress,privyWalletId:'agent',privyOwnerId:'agent-owner',signerAddress:`0x${'22'.repeat(20)}` });
  await db.insert(copyWalletAuthorizations).values({id:'grant',walletId:'local-agent',version:1,scopes:['copy:trade'],validFrom:new Date(Date.now()-3000),expiresAt:new Date(Date.now()+60000)});
  await db.insert(copyExecutionAccounts).values({ id: accountId, userId: uid, strategyId, network: "testnet", privyUserId: "did:privy:follower",
    externalId: "master", state: "ready", address: accountAddress, privyWalletId: "master-wallet", ownerQuorumId: "owner" });
});
afterAll(closeTestDb);
describe("actual follower receipt ledger", () => {
  it('attributes actual partial IOC fills using the immutable ACK OID after the journal lost its outcome', async () => {
    const {record} = await evidenceOnly();
    expect(await ledger.bookFill(accountId,fill({sz:'0.005'}))).toEqual({inserted:true,quarantined:false});
    expect((await db.select().from(copyFollowerReceipts))[0]).toMatchObject({executionKey:record.key,attribution:'execution'});
  });
  it('validates durable status-only OID binding independently of current source freshness', async () => {
    const {record} = await evidenceOnly(60000); const at=record.createdAt+1500;
    const observation = parseLiveOrderEvidence({record,market:record.market!,checkedAt:at,completedAt:at,now:at,raw:{status:'order',order:{status:'filled',statusTimestamp:at,
      order:{coin:'BTC',oid:7,cloid:record.action.orders[0].c,side:'B',reduceOnly:false,tif:'Ioc',origSz:'0.01',sz:'0.01',limitPx:'20000',timestamp:record.createdAt,isTrigger:false,isPositionTpsl:false,children:[]}}}});
    await db.update(copyLiveExecutionEvidence).set({acknowledgement:null,acknowledgementDigest:null,statusObservation:observation as unknown as Record<string,unknown>,statusDigest:observation.sourceDigest});
    expect(await ledger.bookFill(accountId,fill({time:record.createdAt+1000}))).toEqual({inserted:true,quarantined:false});
  });
  it.each(['digest','nonce','owner','cloid','wallet','coin','side','master'])('quarantines invalid evidence-backed %s identity rather than guessing attribution',async mismatch=>{
    const {record,acknowledgement} = await evidenceOnly();
    if(mismatch==='digest') await db.update(copyLiveExecutionEvidence).set({acknowledgementDigest:'a'.repeat(64)});
    if(mismatch==='nonce') await db.update(copyLiveExecutionEvidence).set({nonce:record.nonce+1});
    if(mismatch==='owner') await db.update(users).set({privyUserId:'did:privy:changed'}).where(eq(users.id,uid));
    if(mismatch==='cloid') await db.update(copyLiveExecutionEvidence).set({cloid:`0x${'44'.repeat(16)}`});
    if(mismatch==='wallet') await db.update(copyExecutionWallets).set({privyOwnerId:'changed-owner'});
    if(mismatch==='master') await db.update(copyExecutionAccounts).set({state:'blocked',privyWalletId:null});
    if(mismatch==='coin') await db.update(copyLiveExecutionEvidence).set({acknowledgement:{...acknowledgement,identity:{...acknowledgement.identity,market:{...acknowledgement.identity.market,coin:'ETH'}}}});
    const receipt=fill({sz:'0.005',...(mismatch==='side'?{side:'A'}:{})});
    expect(await ledger.bookFill(accountId,receipt)).toMatchObject({inserted:true,quarantined:true});
    expect((await db.select().from(copyFollowerReceipts))[0]).toMatchObject({executionKey:null,attribution:'account'});
  });
  it('strictly validates direct journal fingerprint rather than trusting a scalar outcome OID',async()=>{
    const record=await execution();await db.update(copyLiveExecutions).set({record:{...record,fingerprint:'a'.repeat(64)}});
    expect(await ledger.bookFill(accountId,fill())).toMatchObject({quarantined:true});
    expect((await db.select().from(copyFollowerReceipts))[0]?.executionKey).toBeNull();
  });
  it('preserves immutable fallback booking after grant revocation, expiry, strategy stop and owner disablement',async()=>{
    await evidenceOnly();await db.update(copyWalletAuthorizations).set({version:2,revokedAt:new Date(),expiresAt:new Date(Date.now()-500)});
    await db.update(users).set({disabledAt:new Date()}).where(eq(users.id,uid));await db.update(copyStrategies).set({status:'stopped',stoppedAt:new Date()}).where(eq(copyStrategies.id,strategyId));
    expect(await ledger.bookFill(accountId,fill({sz:'0.005'}))).toEqual({inserted:true,quarantined:false});
  });


  it('quarantines differing direct and evidence keys for one account OID instead of preferring a candidate',async()=>{
    await evidenceOnly(); await execution('BTC','44');
    expect(await ledger.bookFill(accountId,fill({sz:'0.005'}))).toMatchObject({quarantined:true});
    expect((await db.select().from(copyFollowerReceipts))[0]?.executionKey).toBeNull();
  });
  it('does not bypass corrupted evidence just because the direct journal still names the same OID',async()=>{
    const {record}=await evidenceOnly();
    await db.update(copyLiveExecutions).set({record:{...record,outcome:{state:'partial',exchangeOrderId:'7'}}});
    await db.update(copyLiveExecutionEvidence).set({acknowledgementDigest:'b'.repeat(64)});
    expect(await ledger.bookFill(accountId,fill({sz:'0.005'}))).toMatchObject({quarantined:true});
  });
  it('replays reordered actual nested provider raw fields without rehashing or duplicating booked components',async()=>{
    await execution(); const raw=fill({source:{z:[{B:'2',a:'1'}],_source:'provider'}});
    expect(await ledger.bookFill(accountId,raw)).toEqual({inserted:true,quarantined:false});
    const reordered={...raw,source:{_source:'provider',z:[{a:'1',B:'2'}]}};
    expect(await ledger.bookFill(accountId,reordered)).toEqual({inserted:false,quarantined:false});
    expect(await db.select().from(copyFollowerLedger)).toHaveLength(3);
    expect((await db.select().from(copyFollowerReceipts))[0]?.record.raw).toEqual(raw);
  });

  it.each(['master','network'])('quarantines a genuinely bound foreign historical journal %s despite the local evidence mirror',async mismatch=>{
    const {record} = await evidenceOnly();
    const account = mismatch==='master'?`0x${'77'.repeat(20)}`:accountAddress;
    const intent:LiveOrderIntent={authorizationId:'grant',userId:uid,strategyId,walletId:'agent',network:'testnet',accountAddress:account as `0x${string}`,reduceOnly:false,
      cloid:record.action.orders[0].c,asset:0,side:'B',size:'0.01',limitPrice:'20000',sizeDecimals:5,timeInForce:'Ioc',market:record.market!};
    const foreign={...record,key:executionKey(intent),fingerprint:intentFingerprint(intent,record.action),authorization:{...record.authorization,accountAddress:intent.accountAddress}};
    const ack=parseLiveIocAcknowledgement({identity:captureLiveOrderIdentity(foreign,foreign.market!),checkedAt:record.createdAt+1500,
      raw:{status:'ok',response:{type:'order',data:{statuses:[{filled:{oid:7,totalSz:'0.005',avgPx:'20000'}}]}}}});
    await db.delete(copyLiveExecutionEvidence);await db.delete(copyLiveExecutions);
    await db.insert(copyLiveExecutions).values({key:foreign.key,network:mismatch==='network'?'mainnet':'testnet',accountAddress:account,signerAddress:foreign.authorization.signerAddress,
      cloid:foreign.action.orders[0].c,nonce:foreign.nonce,userId:uid,strategyId,state:foreign.state,record:foreign as unknown as Record<string,unknown>,updatedAt:new Date(foreign.updatedAt)});
    await db.insert(copyLiveExecutionEvidence).values({key:foreign.key,accountId,userId:uid,strategyId,network:'testnet',accountAddress,cloid:foreign.action.orders[0].c,
      fingerprint:foreign.fingerprint,nonce:foreign.nonce,exchangeOrderId:'7',acknowledgement:ack as unknown as Record<string,unknown>,acknowledgementDigest:ack.responseDigest,
      createdAt:new Date(),updatedAt:new Date()});
    expect(await ledger.bookFill(accountId,fill({sz:'0.005',time:record.createdAt+1000}))).toMatchObject({quarantined:true});
    expect((await db.select().from(copyFollowerReceipts))[0]?.executionKey).toBeNull();
  });
  it("owner statement separates actual fee components and funding without fabricating equity", async () => {
    await execution(); await ledger.bookFill(accountId, fill());
    await ledger.bookFunding(accountId, { hash: `0x${"66".repeat(32)}`, time: Date.now() - 1000, delta: { type: "funding", coin: "BTC", usdc: "-0.37" } });
    const statement = await new CopyFollowerStatementService(new CopyFollowerStatementRepository(db)).get(uid, accountId);
    expect(copyFollowerStatementSchema.parse(statement)).toMatchObject({ token: "USDC", receiptCount: "2", actual: {
      realizedPnl: "2", exchangeFee: "-0.04", builderFee: "-0.02", funding: "-0.37", tradingCashDelta: "1.57" },
      coverage: { historicalCompleteness: "unproven", scannedThrough: null, unresolvedWindows: null }, latestReceipts: [expect.anything(), expect.anything()] });
    expect(statement).not.toHaveProperty("equity");
  });
  it("never exposes an account statement to another owner or a disabled identity", async () => {
    const other = (await insertUser(db, { privyUserId: "did:privy:other" })).id;
    const statements = new CopyFollowerStatementService(new CopyFollowerStatementRepository(db));
    await expect(statements.get(other, accountId)).rejects.toThrow("Execution account not found");
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, uid));
    await expect(statements.get(uid, accountId)).rejects.toThrow("Execution account not found");
  });
  it("books inclusive fee exactly once and retains partial-order attribution", async () => {
    await execution(); const receipt = fill();
    expect(await ledger.bookFill(accountId, receipt)).toEqual({ inserted: true, quarantined: false });
    const components = await db.select().from(copyFollowerLedger);
    expect(Object.fromEntries(components.map(r => [r.component, r.amount]))).toEqual({ realized_pnl: "2", exchange_fee: "-0.04", builder_fee: "-0.02" });
    expect((await db.select().from(copyFollowerReceipts))[0]).toMatchObject({ executionKey: expect.stringContaining("testnet:"), attribution: "execution" });
    expect(await db.select().from(copyPaperFills)).toHaveLength(0);
    expect((await db.select().from(copyStrategies))[0].cash).toBe("100");
  });
  it("concurrent identical receipts are a single immutable booking", async () => {
    await execution(); const receipt = fill();
    const results = await Promise.all([ledger.bookFill(accountId, receipt), ledger.bookFill(accountId, receipt)]);
    expect(results.filter(r => r.inserted)).toHaveLength(1);
    expect(await db.select().from(copyFollowerReceipts)).toHaveLength(1);
    expect(await db.select().from(copyFollowerLedger)).toHaveLength(3);
  });
  it("changed payload with the same identity quarantines durably without rewriting cash", async () => {
    await execution(); const receipt = fill(); await ledger.bookFill(accountId, receipt);
    await expect(ledger.bookFill(accountId, { ...receipt, fee: "0.07" })).rejects.toThrow("follower_receipt_conflict");
    expect((await db.select().from(copyFollowerAccountState))[0]).toMatchObject({ quarantined: true, reason: "follower_receipt_conflict" });
    expect(await db.select().from(copyFollowerReceiptConflicts)).toHaveLength(1);
    expect((await db.select().from(copyFollowerReceipts))[0].record.totalFee).toBe("0.06");
    expect((await db.select().from(copyFollowerLedger)).find(r => r.component === "exchange_fee")?.amount).toBe("-0.04");
  });
  it("malformed replay of a known receipt also commits conflict evidence", async () => {
    await execution(); const receipt = fill(); await ledger.bookFill(accountId, receipt);
    await expect(ledger.bookFill(accountId, { ...receipt, fee: null })).rejects.toThrow("follower_receipt_conflict");
    expect((await db.select().from(copyFollowerAccountState))[0].quarantined).toBe(true);
    expect(await db.select().from(copyFollowerReceiptConflicts)).toHaveLength(1);
    expect((await db.select().from(copyFollowerLedger)).find(r => r.component === "exchange_fee")?.amount).toBe("-0.04");
  });
  it("retains external fills as account evidence and quarantines unmatched trading", async () => {
    expect(await ledger.bookFill(accountId, fill())).toEqual({ inserted: true, quarantined: true });
    expect((await db.select().from(copyFollowerReceipts))[0]).toMatchObject({ executionKey: null, attribution: "account" });
  });
  it("wrong market for an oid is never attributed to a valid execution", async () => {
    await execution("ETH");
    expect(await ledger.bookFill(accountId, fill())).toEqual({ inserted: true, quarantined: true });
    expect((await db.select().from(copyFollowerAccountState))[0].reason).toBe("follower_execution_identity_mismatch");
  });
  it("books actual signed maker rebates rather than simulated nonnegative fees", async () => {
    await execution(); await ledger.bookFill(accountId, fill({ closedPnl: "0", fee: "-0.03", builderFee: "0" }));
    expect((await db.select().from(copyFollowerLedger)).map(r => [r.component, r.amount])).toEqual([["exchange_fee", "0.03"]]);
  });
  it("funding is actual signed movement with replay protection", async () => {
    const receipt = { hash: `0x${"66".repeat(32)}`, time: Date.now() - 1000, delta: { type: "funding", coin: "BTC", usdc: "-0.37" } };
    expect(await ledger.bookFunding(accountId, receipt)).toEqual({ inserted: true, quarantined: false });
    expect(await ledger.bookFunding(accountId, receipt)).toEqual({ inserted: false, quarantined: false });
    expect((await db.select().from(copyFollowerLedger)).map(r => [r.component, r.amount])).toEqual([["funding", "-0.37"]]);
    await expect(ledger.bookFunding(accountId, { ...receipt, delta: { ...receipt.delta, usdc: null } })).rejects.toThrow("follower_receipt_conflict");
    expect((await db.select().from(copyFollowerAccountState))[0].quarantined).toBe(true);
    expect(await db.select().from(copyFollowerReceiptConflicts)).toHaveLength(1);
  });
  it("continues read-only booking after owner disablement and strategy stop", async () => {
    await execution(); await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, uid));
    await db.update(copyStrategies).set({ status: "stopped", cash: "0", stoppedAt: new Date() }).where(eq(copyStrategies.id, strategyId));
    expect((await ledger.bookFill(accountId, fill())).inserted).toBe(true);
  });
  it("refuses malformed, foreign-network and future receipts before any booking", async () => {
    for (const patch of [{ side: ["B"] }, { fee: undefined }, { network: "mainnet" }, { user: `0x${"77".repeat(20)}` }, { time: Date.now() + 60_000 }])
      await expect(ledger.bookFill(accountId, fill(patch))).rejects.toThrow();
    expect(await db.select().from(copyFollowerReceipts)).toHaveLength(0);
  });
});
