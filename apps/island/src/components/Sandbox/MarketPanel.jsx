/**
 * The market dock: the right-hand column of the frame, where the money is.
 *
 * One flush panel in three parts. The header says where the money lives
 * (NEAR testnet or practice chips), whether betting is open, and the pool,
 * the one number the dock exists for. Under it, three tabs:
 *
 *   ODDS        the season's price chart and the bet slip for the followed agent
 *   YOUR BETS   every stake the viewer holds, what it pays, and the claim
 *   ON CHAIN    where the season lives on NEAR and every transaction it saw
 *
 * The slip is for the followed agent; picking an agent anywhere in the dock
 * follows it through `onFollow`. On a TV there are no tabs and no slip, only
 * the odds. The dock folds to an edge tab that still shows the pool.
 */

import { useEffect, useRef, useState } from 'react';
import { useSandbox } from '../../context/SandboxContext';
import { useColumnPresence, useLayout } from '../../context/LayoutContext';
import { explorerAccount, shortAccount } from '../../services/explorer';
import { useBets } from './BettingContext';
import Tabs, { tabPanelProps } from '../ui/Tabs';
import {
  IconExternal, IconFoldRight, IconHelp, IconLock,
} from '../ui/icons';
import MarketChart from './market/MarketChart';
import BetSlip from './market/BetSlip';
import YourBets from './market/YourBets';
import OnChain, { useNearBlock } from './market/OnChain';
import HowBetting from './market/HowBetting';
import { Amount, moneyOf } from './market/bits';
import '../../styles/market.css';

const DOCK_ID = 'qf-market-dock';

/** The market's state for the header pill. */
function marketState(m) {
  if (m.mode === 'chain') {
    if (m.readState === 'loading') return 'reading';
    if (m.readState === 'waiting') return 'opening';
    if (m.status === 'settled') return 'settled';
    if (m.status === 'cancelled') return 'cancelled';
    return m.bettingOpen ? 'open' : 'locked';
  }
  // practice chips stay open until the game ends and settle at once
  return m.bettingOpen ? 'open' : 'settled';
}

function StatePill({ state }) {
  switch (state) {
    case 'open':
      return <span className="qf-pill qf-mkt-state qf-mkt-state--open"><i className="qf-dot" aria-hidden />Open</span>;
    case 'locked':
      return <span className="qf-pill qf-mkt-state qf-mkt-state--locked"><IconLock size={12} />Locked</span>;
    case 'settled':
      return <span className="qf-pill qf-pill--amber qf-mkt-state">Settled</span>;
    case 'cancelled':
      return <span className="qf-pill qf-pill--red qf-mkt-state">Cancelled</span>;
    case 'opening':
      return <span className="qf-pill qf-mkt-state qf-mkt-state--wait">Opening…</span>;
    default:
      return <span className="qf-pill qf-mkt-state qf-mkt-state--wait">Reading…</span>;
  }
}

export default function MarketPanel({ onFollow }) {
  const { world, roster } = useSandbox();
  const m = useBets();
  const {
    dockOpen, toggleDock, tv,
  } = useLayout();
  const { chain, unit, fmt } = moneyOf(m);
  const worldId = world?.world_id ?? null;

  // The simulated market opens with the season. The contract's opens with
  // the lobby, and the game server locks it a few ticks into the season, so
  // on chain the lobby is when most bets are placed.
  const shown = roster.length > 0 && !(world?.phase === 'lobby' && !chain);
  useColumnPresence('dock', shown);
  const block = useNearBlock(chain && shown);

  const [tab, setTab] = useState('odds');
  const [help, setHelp] = useState(false);
  useEffect(() => { setTab('odds'); }, [worldId]);

  // Once the season has a result for this viewer, YOUR BETS comes forward
  // by itself, once per season.
  const result = chain
    ? ['claimable', 'lost', 'paid'].includes(m.payout?.state)
    : Boolean(m.payout);
  const resultFor = result ? worldId : null;
  const switchedFor = useRef(null);
  useEffect(() => {
    if (!resultFor || tv || switchedFor.current === resultFor) return;
    switchedFor.current = resultFor;
    setTab('bets');
  }, [resultFor, tv]);

  if (!shown) return null;

  const live = !chain || m.readState === 'live';
  const pool = live ? m.pools.total : null;
  const backed = Object.values(m.bets).filter((v) => v > 0).length;
  const claimable = chain && m.payout?.state === 'claimable';
  const hasAccount = !chain || m.hasAccount;
  const state = marketState(m);

  const tabs = [
    { id: 'odds', label: 'Odds' },
    {
      id: 'bets',
      label: 'Your bets',
      badge: backed > 0 ? backed : null,
      badgeTone: claimable ? 'amber' : '',
    },
    ...(chain ? [{ id: 'chain', label: 'On chain' }] : []),
  ];
  const current = tabs.some((t) => t.id === tab) ? tab : 'odds';
  const seeBets = () => setTab('bets');

  let panel;
  if (tv || current === 'odds') {
    panel = (
      <>
        <MarketChart onFollow={onFollow} />
        {!tv && <BetSlip onFollow={onFollow} onSeeBets={seeBets} />}
      </>
    );
  } else if (current === 'bets') {
    panel = <YourBets onFollow={onFollow} />;
  } else {
    panel = <OnChain block={block} />;
  }

  return (
    <>
      {!dockOpen && (
        <button
          type="button"
          className="qf-edge qf-edge--dock qf-mkt-edge"
          onClick={toggleDock}
          aria-expanded="false"
          aria-controls={DOCK_ID}
          aria-label={pool != null ? `Open the market, pool ${fmt(pool)} ${unit}` : 'Open the market'}
        >
          <span>Market</span>
          {pool != null && (
            <b className="qf-mkt-edge__pool">
              {fmt(pool)}
              <small>{unit}</small>
            </b>
          )}
        </button>
      )}
      <aside
        id={DOCK_ID}
        className="qf-col qf-col--dock"
        aria-label="Market"
        inert={!dockOpen || undefined}
      >
        <section className="qf-panel qf-panel--flush qf-mkt">
          <header className="qf-mkt-head">
            <h2 className="qf-head qf-mkt-head__title">Market</h2>
            <div className="qf-mkt-head__tools">
              <StatePill state={state} />
              {!tv && (
                <>
                  <button
                    type="button"
                    className="qf-btn qf-btn--quiet qf-btn--icon qf-mkt-head__btn"
                    onClick={() => setHelp(true)}
                    aria-label="How betting works"
                    aria-haspopup="dialog"
                  >
                    <IconHelp />
                  </button>
                  <button
                    type="button"
                    className="qf-btn qf-btn--quiet qf-btn--icon qf-mkt-head__btn"
                    onClick={toggleDock}
                    aria-label="Fold the market away"
                    aria-expanded="true"
                    aria-controls={DOCK_ID}
                  >
                    <IconFoldRight />
                  </button>
                </>
              )}
            </div>
            {chain ? (
              m.contractId ? (
                <a
                  className="qf-mkt-head__where"
                  href={explorerAccount(m.contractId)}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`NEAR testnet, contract ${m.contractId} on the explorer`}
                >
                  <span>NEAR testnet · {shortAccount(m.contractId, 24)}</span>
                  <IconExternal size={11} />
                </a>
              ) : <span className="qf-mkt-head__where">NEAR testnet</span>
            ) : (
              <span className="qf-mkt-head__where">Practice chips · not NEAR</span>
            )}
            {state === 'open' && chain && m.lockTick != null && (
              <span className="qf-mkt-head__lock">Locks at tick {m.lockTick}</span>
            )}
          </header>

          <div className="qf-mkt-pool">
            <div className="qf-mkt-pool__main">
              <div className="qf-label">Pool</div>
              <Amount value={pool} unit={unit} fmt={fmt} tone="amber" size="hero" className="qf-mkt-pool__num" />
            </div>
            <div className="qf-mkt-pool__side">
              <div className="qf-label qf-mkt-pool__you">Your stake</div>
              <Amount value={hasAccount && live ? m.myTotal : null} unit={unit} fmt={fmt} tone="ice" />
            </div>
          </div>

          {!tv && (
            <Tabs tabs={tabs} value={current} onChange={setTab} label="Market" group="market" className="qf-mkt-tabs" />
          )}

          <div
            key={tv ? 'odds' : current}
            className="qf-mkt-body"
            {...(tv ? {} : tabPanelProps('market', current))}
            tabIndex={0}
          >
            {panel}
          </div>
        </section>
      </aside>
      {help && <HowBetting onClose={() => setHelp(false)} />}
    </>
  );
}
