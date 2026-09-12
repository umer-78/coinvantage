// Read-only wallet connection.
//
// This asks an injected wallet (MetaMask, Rabby, Coinbase Wallet, Brave…) for
// nothing but the account address, using the standard `eth_requestAccounts`
// permission. It never requests a signature, never builds a transaction, and
// never sees a private key or seed phrase — the address it gets back is public
// information you could equally type in by hand. The address is then used with
// the same read-only balance lookup as a manually pasted one.
import { CHAINS } from './market.js';

// Chain id (hex) -> the network key used by the watch-only balance lookup.
const CHAIN_BY_ID = { '0x1': 'eth', '0x38': 'bsc', '0x89': 'polygon' };

export const injectedWallet = () => (typeof window === 'undefined' ? null : window.ethereum || null);

export function walletLabel() {
  const p = injectedWallet();
  if (!p) return null;
  if (p.isRabby) return 'Rabby';
  if (p.isCoinbaseWallet) return 'Coinbase Wallet';
  if (p.isBraveWallet) return 'Brave Wallet';
  if (p.isTrust) return 'Trust Wallet';
  if (p.isMetaMask) return 'MetaMask';
  return 'your wallet';
}

/**
 * Ask the wallet for its addresses. Resolves to { addresses, chain, label }.
 * Rejects with a readable message if the person declines or no wallet exists.
 */
export async function connectWallet() {
  const provider = injectedWallet();
  if (!provider) {
    throw new Error('No browser wallet found. Install MetaMask (or any EVM wallet), or paste your public address instead — both are read-only here.');
  }
  let accounts;
  try {
    accounts = await provider.request({ method: 'eth_requestAccounts' });
  } catch (e) {
    if (e?.code === 4001) throw new Error('You declined the connection. Nothing was shared.');
    throw new Error(e?.message || 'The wallet refused the connection.');
  }
  if (!accounts?.length) throw new Error('The wallet returned no address.');

  let chain = 'eth';
  try {
    const id = await provider.request({ method: 'eth_chainId' });
    chain = CHAIN_BY_ID[id] || 'eth';
  } catch { /* default to Ethereum */ }

  return {
    addresses: accounts.filter((a) => CHAINS.eth.pattern.test(a)),
    chain,
    label: walletLabel(),
  };
}

/** Fires when the person switches account or network in their wallet. */
export function onWalletChange(handler) {
  const provider = injectedWallet();
  if (!provider?.on) return () => {};
  const onAccounts = (accs) => handler({ type: 'accounts', addresses: accs });
  const onChain = (id) => handler({ type: 'chain', chain: CHAIN_BY_ID[id] || 'eth' });
  provider.on('accountsChanged', onAccounts);
  provider.on('chainChanged', onChain);
  return () => {
    provider.removeListener?.('accountsChanged', onAccounts);
    provider.removeListener?.('chainChanged', onChain);
  };
}
