import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import * as api from '../../lib/api.js';
import { signAndSubmitNftWithdrawal } from '../../lib/withdraw.js';
import { usd, RARITY_COLORS, hideBrokenImg } from './gacha-util.js';

const tierColor = (r) => RARITY_COLORS[(r || '').toLowerCase()] ?? '#9aa0aa'; // rarity → its tier colour (grey fallback)

// The player's Classic Gacha NFT inventory (docs/classic-gacha-cc-packs-spec.md §12 + decision #4). Held graded
// slabs with per-row Sell back (−cut, instant) / Trade (when the card matched a GDEX market) / Withdraw (the real
// NFT to an external wallet, via a fresh wallet signature over (mint, dest)). Self-contained: fetches its own
// inventory and refreshes after each action; `refreshKey` lets a parent (the lobby, after a pull) force a reload.
// Renders nothing when there's no session or nothing held, so a host page just omits the section.


export function GachaInventory({ onTradeMarket, refreshKey = 0, heading = 'Your gacha pulls' }) {
  const [inventory, setInventory] = useState([]);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null); // neutral "processing" notice (e.g. a sell-back broadcast, awaiting on-chain settle)
  const { signMessage } = useWallet();

  const load = useCallback(() => {
    if (!api.hasSession()) { setInventory([]); return; }
    api.getGachaInventory().then((r) => setInventory(r.inventory ?? [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  const sellBack = async (item) => {
    setErr(null); setNote(null);
    try { await api.sellGachaPrize(item.id, false); load(); } // manual sell-back keeps the lower (5%) cut
    catch (e) {
      // Sell-back broadcast but unconfirmed → the card stays 'selling' and the reconciler settles it shortly.
      if (e.code === 'buyback_pending') { setNote(e.message); load(); }
      else setErr(e.message);
    }
  };
  const trade = (item) => { if (onTradeMarket && item?.marketId) onTradeMarket({ id: item.marketId }); };
  const convert = async (item) => {
    setErr(null); setNote(null);
    if (!window.confirm('Sell this card and open a 2× long on its market with the proceeds? You can adjust the position after.')) return;
    try {
      const r = await api.convertGachaPrize(item.id, { side: 'long', leverage: 2 });
      load();
      if (r.positionError) setErr(`Sold for the proceeds, but the position didn’t open: ${r.positionError}`);
      else trade(item); // jump to the card's market to manage the new position
    } catch (e) { setErr(e.message); }
  };
  const withdraw = async (item) => {
    setErr(null); setNote(null);
    if (!signMessage) { setErr('Connect a wallet that can sign messages to withdraw.'); return; }
    const dest = window.prompt('Withdraw this card NFT to which Solana wallet address?');
    if (!dest) return;
    try { await signAndSubmitNftWithdrawal({ prizeId: item.id, dest: dest.trim(), signMessage }); load(); }
    catch (e) { setErr(e?.status === 401 ? 'Sign in to withdraw.' : e.message); }
  };

  if (inventory.length === 0) return null;

  return (
    <section className="gacha-inventory">
      <h4>{heading} ({inventory.length})</h4>
      {err && <div className="order-error">{err}</div>}
      {note && <div className="order-pending">{note}</div>}
      <div className="gacha-card-grid">
        {inventory.map((it) => (
          <div key={it.id} className="gacha-card">
            {it.imageUrl && <img src={it.imageUrl} alt={it.name ?? ''} loading="lazy" referrerPolicy="no-referrer" onError={hideBrokenImg} />}
            <span className="gacha-card-name" title={it.name ?? ''}>{it.name ?? 'card'}{it.grade ? ` · ${it.grade}` : ''}</span>
            <span className="gacha-card-val">{usd(it.valueE6)}</span>
            {it.rarity && <span className="gacha-card-tier" style={{ color: tierColor(it.rarity) }}>{it.rarity}</span>}
            {it.status === 'held' ? (
              <>
                <button className="btn-ghost sm" onClick={() => sellBack(it)}>Sell back</button>
                {it.marketId && <button className="btn-ghost sm" onClick={() => trade(it)}>Trade</button>}
                {it.marketId && <button className="btn-ghost sm" onClick={() => convert(it)}>Convert</button>}
                <button className="btn-ghost sm" onClick={() => withdraw(it)}>Withdraw</button>
              </>
            ) : (
              <span className="muted" style={{ fontSize: '0.72rem' }}>{it.status === 'withdrawing' ? 'Withdrawal in progress…' : it.status === 'selling' ? 'Selling…' : it.status}</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
