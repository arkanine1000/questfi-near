/**
 * An agent's dossier: a small floating window with what the world state
 * knows about one agent, its agent pass as the contract records it (when it
 * has one and the island runs on NEAR), and its last few thoughts.
 *
 * SandboxView keeps which dossiers are open (at most three) and where each
 * first appears; the window itself remembers where it was dragged.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSandbox } from '../../context/SandboxContext';
import { useNear } from '../../context/NearContext';
import { formatNear } from '../../services/marketMath';
import FloatingWindow from '../ui/FloatingWindow';
import { IconFollow } from '../ui/icons';
import { useBets } from './BettingContext';
import {
  AgentHex, agentMarket, deathSentence, isYours, siteName,
} from './Field';

const MAX_THOUGHTS = 3;

/**
 * The pass's record from the contract (`get_pass`): loading, ok, or none.
 * A failed read is simply none: the dossier then says nothing about it.
 */
function usePassRecord(passId) {
  const { enabled, chain, error } = useNear();
  const [state, setState] = useState({ status: 'none', pass: null });
  const id = passId != null && passId !== '' ? String(passId) : null;

  useEffect(() => {
    if (!enabled || !id) {
      setState({ status: 'none', pass: null });
      return undefined;
    }
    // near-api-js loads lazily; until it has, the read is still coming
    // (unless it failed to load at all).
    if (!chain?.getPass) {
      setState({ status: error && !chain ? 'none' : 'loading', pass: null });
      return undefined;
    }
    let live = true;
    setState({ status: 'loading', pass: null });
    chain.getPass(id)
      .then((pass) => { if (live) setState(pass ? { status: 'ok', pass } : { status: 'none', pass: null }); })
      .catch(() => { if (live) setState({ status: 'none', pass: null }); });
    return () => { live = false; };
  }, [enabled, chain, error, id]);

  return state;
}

function Row({ label, children, className = '' }) {
  return (
    <div className={`qf-row ${className}`}>
      <span>{label}</span>
      <span className="qf-dossier-val">{children}</span>
    </div>
  );
}

export default function Dossier({
  agentId, initial, onClose, onFollow,
}) {
  const {
    roster, islandMap, agentFeeds, followedAgentId,
  } = useSandbox();
  const market = useBets();
  const agent = roster.find((a) => a.agent_id === agentId) ?? null;
  const pass = usePassRecord(agent?.pass_id);
  const { enabled: onNear } = useNear();

  // Newest first, consecutive repeats collapsed, as the thought cards do.
  const thoughts = useMemo(() => {
    const out = [];
    for (const t of agentFeeds[agentId]?.thoughts ?? []) {
      if (!t.text) continue;
      if (out.length && out[out.length - 1].text === t.text) continue;
      out.push(t);
    }
    return out.slice(-MAX_THOUGHTS).reverse();
  }, [agentFeeds, agentId]);

  if (!agent) return null;

  const alive = agent.alive;
  const m = agentMarket(market, agent);
  const pos = agent.position || {};
  let where = null;
  if (alive && pos.kind === 'dungeon') where = siteName(islandMap, pos.site_id) ?? 'Underground';
  else if (alive && pos.hex) where = `Hex ${pos.hex}`;
  const followed = agent.agent_id === followedAgentId;
  const showPass = onNear && agent.pass_id != null && agent.pass_id !== '' && pass.status !== 'none';

  return (
    <FloatingWindow
      id={`dossier-${agent.agent_id}`}
      title={`Dossier · ${agent.name}`}
      accent={agent.color}
      width={320}
      initial={initial}
      onClose={onClose}
      className="qf-dossier"
    >
      <div className="qf-dossier-body" style={{ '--agent': agent.color }}>
        <header className="qf-dossier-id">
          <AgentHex agent={agent} size={30} fighting={alive && Boolean(agent.in_combat)} />
          <div className="qf-dossier-who">
            <h3 className="qf-dossier-name">{agent.name}</h3>
            <div className="qf-dossier-tags">
              {agent.brain === 'external' && <span className="qf-field-tag">API</span>}
              {isYours(agent) && <span className="qf-field-tag qf-field-tag--ice">Yours</span>}
              {!alive && <span className="qf-field-tag qf-dossier-fallen">Fallen</span>}
              {alive && agent.in_combat && <span className="qf-dossier-combat">In combat</span>}
            </div>
          </div>
        </header>

        <div className="qf-dossier-rows">
          <Row label="Status">
            {alive ? (
              <>
                <span className="qf-dossier-alive">Alive</span>
                <span className="qf-num qf-num--small">HP {agent.hp}/{agent.max_hp}</span>
              </>
            ) : (
              <span className="qf-dossier-fate">{deathSentence(agent)}</span>
            )}
          </Row>
          {agent.kills != null && (
            <Row label="Kills"><span className="qf-num qf-num--small">{agent.kills}</span></Row>
          )}
          {agent.mob_kills > 0 && (
            <Row label="Monsters slain"><span className="qf-num qf-num--small">{agent.mob_kills}</span></Row>
          )}
          {agent.weapon && (
            <Row label="Weapon">
              <span className="qf-dossier-text">{agent.weapon}</span>
              {agent.weapon_bonus > 0 && <span className="qf-num qf-num--small">+{agent.weapon_bonus}</span>}
            </Row>
          )}
          {where && (
            <Row label={pos.kind === 'dungeon' ? 'Underground' : 'Where'}>
              <span className="qf-dossier-text">{where}</span>
            </Row>
          )}
          {alive && (m.price || m.noMarket) && (
            <Row label="Market">
              {m.noMarket ? (
                <span className="qf-dossier-text qf-dossier-faint">No pass, no market</span>
              ) : (
                <>
                  <span className="qf-num qf-num--small">{m.price}</span>
                  {m.odds && <span className="qf-dossier-odds">{m.odds}</span>}
                </>
              )}
            </Row>
          )}
          {m.stake > 0 && (
            <Row label="Your stake" className="qf-dossier-mine">
              <span className="qf-num qf-num--small qf-num--ice">{m.stakeText}</span>
              <span className="qf-dossier-unit">{m.onChain ? 'NEAR' : 'chips'}</span>
            </Row>
          )}
        </div>

        {showPass && (
          <section className="qf-dossier-block">
            <h4 className="qf-head">
              <span>Agent pass</span>
              <span className="qf-num">#{agent.pass_id}</span>
            </h4>
            {pass.status === 'loading' ? (
              <p className="qf-muted qf-dossier-wait">Reading the pass on NEAR…</p>
            ) : (
              <>
                <Row label="Level"><span className="qf-num qf-num--small">{pass.pass.level}</span></Row>
                <Row label="Seasons played"><span className="qf-num qf-num--small">{pass.pass.seasons}</span></Row>
                <Row label="Wins"><span className="qf-num qf-num--small">{pass.pass.wins}</span></Row>
                <Row label="Kills"><span className="qf-num qf-num--small">{pass.pass.kills}</span></Row>
                <Row label="Bankroll">
                  <span className="qf-num qf-num--small qf-num--amber">{formatNear(pass.pass.balance ?? '0')}</span>
                  <span className="qf-dossier-unit">NEAR</span>
                </Row>
              </>
            )}
          </section>
        )}

        {thoughts.length > 0 && (
          <section className="qf-dossier-block">
            <h4 className="qf-head"><span>Last thoughts</span></h4>
            <ul className="qf-dossier-thoughts">
              {thoughts.map((t) => (
                <li key={`${t.tick}:${t.text}`} title={t.text}>
                  <span className="qf-dossier-tick">T{t.tick}</span>
                  <span className="qf-dossier-thought">{t.text}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="qf-dossier-foot">
          <button
            type="button"
            className={`qf-btn qf-btn--primary qf-btn--wide${followed ? ' is-on' : ''}`}
            onClick={() => onFollow?.(agent)}
            disabled={!alive}
            title={alive ? undefined : 'The fallen cannot be followed'}
          >
            <IconFollow size={14} />
            {followed ? 'Following' : 'Follow'}
          </button>
        </footer>
      </div>
    </FloatingWindow>
  );
}
