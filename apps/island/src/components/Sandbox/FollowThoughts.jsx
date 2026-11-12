import { useMemo } from 'react';
import { useSandbox } from '../../context/SandboxContext';
import Typewriter from '../Typewriter';

/**
 * Followed agent's thought stream, on the island map.
 *
 * The crawler HUD has always shown these underground; above ground they
 * went missing when the old right-hand FollowPanel was retired, even
 * though SandboxContext never stopped collecting agent_thought events into
 * agentFeeds. Same bottom-center toasts as the crawler, so following an
 * agent reads the same whichever side of a dungeon mouth they're on.
 */

const MAX_TOASTS = 3;

export default function FollowThoughts({ agent, reducedMotion }) {
  const { agentFeeds } = useSandbox();
  const feed = agentFeeds[agent.agent_id];

  // Consecutive repeats (an agent restating the same plan tick after tick)
  // collapse to one card, matching the crawler's pushThought.
  const shown = useMemo(() => {
    const out = [];
    for (const t of feed?.thoughts ?? []) {
      if (!t.text) continue;
      if (out.length && out[out.length - 1].text === t.text) continue;
      out.push(t);
    }
    return out.slice(-MAX_TOASTS);
  }, [feed]);

  if (!shown.length) return null;

  return (
    <div className="sbx-thoughts" style={{ '--chip-color': agent.color }}>
      {shown.map((th, i) => {
        const isLatest = i === shown.length - 1;
        return (
          // Keyed by content, not by window index: the window slides as new
          // thoughts land, and an index key would remount the newest card
          // and restart its typewriter mid-reveal.
          <div
            key={`${th.tick}:${th.text}`}
            className={`sbx-thoughts__card${isLatest ? '' : ' sbx-thoughts__card--old'}`}
          >
            <span className="sbx-thoughts__label">{'> '}{agent.name} (thinking)</span>
            <span className="sbx-thoughts__text">
              {isLatest
                ? <Typewriter text={th.text} reducedMotion={reducedMotion} />
                : th.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
