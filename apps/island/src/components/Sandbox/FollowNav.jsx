/**
 * Follow mode's controls, at the top centre of the stage: the agent being
 * followed on a small plate (its name opens its dossier), the way back to
 * the island view (Esc, or the close button), and the previous and next
 * living agent either side.
 *
 * Also the picker for a hex that holds more than one agent.
 */

import {
  IconClose, IconFollow, IconLeft, IconRight,
} from '../ui/icons';
import { AgentHex } from './Field';

/** A crowded hex: choose who to ride. Sits just above the caster's band. */
export function HexPicker({ agents, onFollow, onClose }) {
  return (
    <div className="qf-panel qf-hexpick" role="group" aria-label="Agents on this hex">
      <span className="qf-hexpick-label">On this hex</span>
      {agents.map((a) => (
        <button
          key={a.agent_id}
          type="button"
          className="qf-hexpick-agent"
          style={{ '--agent': a.color }}
          onClick={() => onFollow(a)}
          title={`Follow ${a.name}`}
        >
          <AgentHex agent={a} size={20} />
          <span>{a.name}</span>
        </button>
      ))}
      <button type="button" className="qf-x" onClick={onClose} aria-label="Close the picker">
        <IconClose size={14} />
      </button>
    </div>
  );
}

/** The previous or next agent: a small quiet button in its colour. */
function Step({ agent, dir, onFollow }) {
  if (!agent) return <span className={`qf-follow-slot qf-follow-slot--${dir}`} />;
  return (
    <span className={`qf-follow-slot qf-follow-slot--${dir}`}>
      <button
        type="button"
        className="qf-btn qf-btn--small qf-btn--quiet qf-follow-step"
        style={{ '--agent': agent.color }}
        onClick={() => onFollow(agent)}
        aria-label={`Follow the ${dir === 'prev' ? 'previous' : 'next'} agent, ${agent.name}`}
        title={`Follow ${agent.name}`}
      >
        {dir === 'prev' && <IconLeft size={14} />}
        <span className="qf-follow-step-name">{agent.name}</span>
        {dir === 'next' && <IconRight size={14} />}
      </button>
    </span>
  );
}

export default function FollowNav({
  agent, prevAgent, nextAgent, onCam = false, onFollow, onExit, onInfo,
}) {
  if (!agent) return null;
  return (
    <nav className="qf-follow" aria-label="Follow mode">
      <Step agent={prevAgent} dir="prev" onFollow={onFollow} />
      <div className="qf-panel qf-follow-plate" style={{ '--agent': agent.color }}>
        {onCam ? (
          <span className="qf-follow-mode is-cam" title="On the dungeon feed">
            <i className="qf-dot qf-dot--live" aria-hidden />
            <span className="qf-follow-mode-text">On cam</span>
          </span>
        ) : (
          <span className="qf-follow-mode" title="Following">
            <IconFollow size={14} />
            <span className="qf-follow-mode-text">Following</span>
          </span>
        )}
        <button
          type="button"
          className="qf-follow-agent"
          onClick={() => onInfo?.(agent)}
          title={`Open the dossier on ${agent.name}`}
        >
          <AgentHex agent={agent} size={20} />
          <span className="qf-follow-name">{agent.name}</span>
        </button>
        <button
          type="button"
          className="qf-key qf-follow-esc"
          onClick={onExit}
          aria-label="Stop following (Escape)"
          title="Back to the island view"
        >
          Esc
        </button>
        <button type="button" className="qf-x qf-follow-close" onClick={onExit} aria-label="Stop following">
          <IconClose size={14} />
        </button>
      </div>
      <Step agent={nextAgent} dir="next" onFollow={onFollow} />
    </nav>
  );
}
