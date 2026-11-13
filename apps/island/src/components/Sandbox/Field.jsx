/**
 * The field: the left-hand column, every agent on the island with its
 * health, where it is, and what the market prices it at.
 *
 * Living agents first, priciest at the top (the order the market list used
 * before), then the fallen under a rule. A row follows its agent when
 * clicked; the small info button beside it opens the agent's dossier, for
 * the dead too. Betting itself lives in the market dock, not here.
 *
 * The column exists while the season runs and after it ends. In the lobby
 * the lobby card shows the seats instead.
 */

import { useEffect, useMemo } from 'react';
import { useSandbox } from '../../context/SandboxContext';
import { useColumnPresence, useLayout } from '../../context/LayoutContext';
import { formatNear } from '../../services/marketMath';
import { useBets } from './BettingContext';
import {
  IconDead, IconDescend, IconFoldLeft, IconInfo, IconKills,
} from '../ui/icons';
import '../../styles/field.css';

/** The agent pass the page was opened for (?pass=): the viewer's own agent. */
const VIEWER_PASS = typeof window !== 'undefined'
  ? new URLSearchParams(window.location.search).get('pass')
  : null;

/** True for the agent that carries the viewer's own pass. */
export function isYours(agent) {
  return VIEWER_PASS != null && agent?.pass_id != null && String(agent.pass_id) === VIEWER_PASS;
}

/** The name of a dungeon site, or null when the map does not give one. */
export function siteName(islandMap, siteId) {
  const name = siteId != null ? islandMap?.sites?.[siteId]?.name : null;
  return typeof name === 'string' && name.trim() ? name : null;
}

/** How an agent died, as a sentence. */
export function deathSentence(agent) {
  const raw = String(agent?.cause_of_death ?? '').trim();
  if (!raw) return 'Fallen.';
  const text = raw[0].toUpperCase() + raw.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** A payout multiple on chain: two decimals while it is small. */
const fmtOdds = (x) => (x < 10 ? x.toFixed(2) : x.toFixed(1));

/**
 * One agent as the market sees it, computed exactly as the market list did:
 * its price (a dash on chain while the pool is empty), its payout multiple,
 * whether it has no market at all (no pass on chain), and the viewer's stake.
 */
export function agentMarket(market, agent) {
  const onChain = market.mode === 'chain';
  // On chain only an agent whose pass is entered in the season has a market,
  // which is unknown until the market has been read.
  const known = !onChain || market.readState === 'live';
  const backable = !onChain || (known && market.canBack(agent));
  const x = agent.alive && backable ? market.odds(agent.agent_id) : null;
  const p = agent.alive ? market.prob(agent.agent_id) : 0;
  let price = null;
  if (agent.alive) {
    if (!onChain) price = `${Math.round(p * 100)}%`;
    else if (backable) price = market.pools.total > 0 ? `${Math.round(p * 100)}%` : '—';
  }
  const stake = market.bets[agent.agent_id] ?? 0;
  return {
    onChain,
    price,
    odds: x != null ? `×${onChain ? fmtOdds(x) : x.toFixed(1)}` : null,
    noMarket: onChain && known && !backable,
    stake,
    stakeText: stake > 0 ? (onChain ? formatNear(stake) : stake.toLocaleString()) : null,
  };
}

/**
 * An agent's hexagon: the island's shape, edged in the agent's colour with
 * its initial inside. The dead get a skull; a fight puts a red light on the
 * corner.
 */
export function AgentHex({ agent, size = 30, fighting = false, className = '' }) {
  const dead = !agent.alive;
  const style = { '--hex': `${size}px` };
  if (!dead && agent.color) {
    style['--hex-edge'] = agent.color;
    style['--hex-fill'] = `color-mix(in srgb, ${agent.color} 16%, #021209)`;
    style['--agent'] = agent.color;
  }
  return (
    <span className={`qf-hex qf-field-hex${dead ? ' is-dead' : ''} ${className}`} style={style} aria-hidden>
      {dead ? <IconDead size={Math.round(size * 0.5)} /> : (agent.name?.trim()?.[0] ?? '?').toUpperCase()}
      {fighting && <i className="qf-field-hex-fight" />}
    </span>
  );
}

function FieldRow({
  agent, followed, market, islandMap, tv, onFollow, onInfo,
}) {
  const alive = agent.alive;
  const m = agentMarket(market, agent);
  const hpFrac = agent.max_hp ? Math.max(0, Math.min(1, agent.hp / agent.max_hp)) : 0;
  const underground = alive && agent.position?.kind === 'dungeon';
  const fighting = alive && Boolean(agent.in_combat);
  const where = underground ? (siteName(islandMap, agent.position.site_id) ?? 'Underground') : null;

  const cls = [
    'qf-field-row',
    followed ? 'is-followed qf-frame' : '',
    alive ? '' : 'is-dead',
    fighting ? 'is-fighting' : '',
  ].filter(Boolean).join(' ');

  const body = (
    <>
      <AgentHex agent={agent} size={30} fighting={fighting} />
      <span className="qf-field-who">
        <span className="qf-field-name">
          <span className="qf-field-name-text">{agent.name}</span>
          {agent.brain === 'external' && (
            <span className="qf-field-tag" title="Plays through the API with its own brain">API</span>
          )}
          {isYours(agent) && <span className="qf-field-tag qf-field-tag--ice" title="Carries your agent pass">Yours</span>}
        </span>
        {alive ? (
          <span className="qf-field-status">
            <span className={`qf-field-hp${hpFrac <= 0.3 ? ' is-low' : ''}`} title={`${agent.hp} of ${agent.max_hp} health`}>
              <span className="qf-field-hpbar"><i style={{ width: `${hpFrac * 100}%` }} /></span>
              <span className="qf-field-hpnum">{agent.hp}/{agent.max_hp}</span>
            </span>
            {agent.kills > 0 && (
              <span className="qf-field-kills" title={`${agent.kills} ${agent.kills === 1 ? 'kill' : 'kills'}`}>
                <IconKills size={12} />{agent.kills}
              </span>
            )}
            {/* a fight is the news: it takes the location's place */}
            {fighting && <span className="qf-field-combat">In combat</span>}
            {!fighting && where && (
              <span className="qf-field-where" title={`Underground: ${where}`}>
                <IconDescend size={12} />
                {/* a leading "The" spends width the name needs */}
                <span>{where.replace(/^the\s+/i, '')}</span>
              </span>
            )}
          </span>
        ) : (
          <span className="qf-field-status qf-field-fate" title={deathSentence(agent)}>{deathSentence(agent)}</span>
        )}
      </span>
      {alive ? (
        <span className="qf-field-price">
          {m.price && <span className="qf-field-prob">{m.price}</span>}
          {m.odds && <span className="qf-field-odds">{m.odds}</span>}
          {m.noMarket && <span className="qf-field-tag qf-field-nopass">No pass</span>}
          {m.stakeText && (
            <span className="qf-field-stake" title="Your stake on this agent">
              You <b>{m.stakeText}</b>{m.onChain ? '' : ' chips'}
            </span>
          )}
        </span>
      ) : <span />}
    </>
  );

  return (
    <li className={cls} style={{ '--agent': agent.color, '--frame': agent.color }}>
      {/* a TV has no pointer; the dead are not followable */}
      {alive && !tv ? (
        <button
          type="button"
          className="qf-field-main"
          onClick={() => onFollow?.(agent)}
          aria-pressed={followed}
          title={followed ? `Following ${agent.name}` : `Follow ${agent.name}`}
        >
          {body}
        </button>
      ) : (
        <div className="qf-field-main">{body}</div>
      )}
      {!tv && (
        <button
          type="button"
          className="qf-field-info"
          onClick={() => onInfo?.(agent)}
          aria-label={`Open the dossier on ${agent.name}`}
          title="Dossier"
        >
          <IconInfo size={15} />
        </button>
      )}
    </li>
  );
}

export default function Field({ onFollow, onInfo }) {
  const {
    world, roster, followedAgentId, islandMap,
  } = useSandbox();
  const { fieldOpen, setFieldOpen, tv } = useLayout();
  const market = useBets();
  const phase = world?.phase;
  const present = phase === 'running' || phase === 'finished';
  useColumnPresence('field', present);

  // A TV has no pointer to bring a folded column back.
  useEffect(() => {
    if (tv && present && !fieldOpen) setFieldOpen(true);
  }, [tv, present, fieldOpen, setFieldOpen]);

  // The market's order: the priciest first, the fallen after, as they fell.
  const { prob } = market;
  const { living, fallen } = useMemo(() => ({
    living: roster.filter((a) => a.alive).sort((a, b) => prob(b.agent_id) - prob(a.agent_id)),
    fallen: roster.filter((a) => !a.alive),
  }), [roster, prob]);

  if (!present) return null;

  const rowProps = {
    market, islandMap, tv, onFollow, onInfo,
  };

  return (
    <>
      {!fieldOpen && !tv && (
        <button
          type="button"
          className="qf-edge qf-edge--field"
          onClick={() => setFieldOpen(true)}
          title="Bring the field back"
        >
          Field
        </button>
      )}
      <aside className="qf-col qf-col--field" aria-label="The field" inert={!fieldOpen || undefined}>
        <section className="qf-panel qf-panel--flush qf-field">
          <header className="qf-field-head">
            <h2 className="qf-field-title">The field</h2>
            <span className="qf-field-count" title={`${living.length} of ${roster.length} still standing`}>
              {living.length}
              <small> / {roster.length}</small>
            </span>
            {!tv && (
              <button
                type="button"
                className="qf-btn qf-btn--icon qf-btn--quiet qf-field-fold"
                onClick={() => setFieldOpen(false)}
                aria-label="Fold the field away"
                title="Fold away"
              >
                <IconFoldLeft />
              </button>
            )}
          </header>
          <ul className="qf-field-list qf-scroll">
            {living.map((agent) => (
              <FieldRow
                key={agent.agent_id}
                agent={agent}
                followed={agent.agent_id === followedAgentId}
                {...rowProps}
              />
            ))}
            {fallen.length > 0 && (
              <li className="qf-field-rule"><span>Fallen · {fallen.length}</span></li>
            )}
            {fallen.map((agent) => (
              <FieldRow key={agent.agent_id} agent={agent} followed={false} {...rowProps} />
            ))}
          </ul>
        </section>
      </aside>
    </>
  );
}
