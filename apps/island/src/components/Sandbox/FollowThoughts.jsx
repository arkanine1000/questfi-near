import { useMemo } from 'react';
import { useSandbox } from '../../context/SandboxContext';
import { IconThought } from '../ui/icons';
import Typewriter from '../Typewriter';

/**
 * The followed agent's thoughts, while it is above ground (underground the
 * dungeon HUD shows them). They sit at the bottom centre of the stage,
 * directly above the caster's band: the newest typed out on a card edged in
 * the agent's colour, the one before it a single dim line above.
 */

const MAX_CARDS = 2;

export default function FollowThoughts({ agent, reducedMotion }) {
  const { agentFeeds } = useSandbox();
  const feed = agentFeeds[agent.agent_id];

  // Consecutive repeats (an agent restating the same plan tick after tick)
  // collapse to one card, matching the dungeon HUD.
  const shown = useMemo(() => {
    const out = [];
    for (const t of feed?.thoughts ?? []) {
      if (!t.text) continue;
      if (out.length && out[out.length - 1].text === t.text) continue;
      out.push(t);
    }
    return out.slice(-MAX_CARDS);
  }, [feed]);

  if (!shown.length) return null;
  const latest = shown[shown.length - 1];
  const before = shown.length > 1 ? shown[0] : null;

  return (
    <div className="qf-thoughts" style={{ '--agent': agent.color }}>
      {/* Keyed by content, not position: the window slides as new thoughts
          land, and a position key would remount the newest card and
          restart its typing mid-line. */}
      {before && (
        <p key={`${before.tick}:${before.text}`} className="qf-thought-old" title={before.text}>
          {before.text}
        </p>
      )}
      <article key={`${latest.tick}:${latest.text}`} className="qf-panel qf-thought">
        <header className="qf-thought-head">
          <IconThought size={12} />
          <span>{agent.name} · Thinking</span>
        </header>
        <p className="qf-thought-text">
          <Typewriter text={latest.text} reducedMotion={reducedMotion} />
        </p>
      </article>
    </div>
  );
}
