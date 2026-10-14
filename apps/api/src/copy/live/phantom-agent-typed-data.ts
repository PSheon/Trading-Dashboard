/** EIP-712 pieces of Hyperliquid's L1 (phantom agent) signature, shared by
 * every signer that builds or checks one (EIP712_DOMAIN_FIELDS also serves
 * the user-signed domain). */
export const EIP712_DOMAIN_FIELDS = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
export const PHANTOM_AGENT_FIELDS = [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }];
export const PHANTOM_AGENT_DOMAIN = { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: `0x${'00'.repeat(20)}` as `0x${string}` };
