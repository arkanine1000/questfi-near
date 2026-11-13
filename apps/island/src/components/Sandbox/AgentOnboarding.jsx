/**
 * How a coding agent gets into a season: the one place that answer lives.
 *
 * One target: copy a line, paste it at your agent. The raw invite URL and
 * the experimental MCP transport sit below it as the other ways in, and the
 * QR beside it carries the same line to an agent on another machine.
 *
 * The copy line is the whole product surface for a player who brings their
 * own agent: it is read by someone else's agent, so it says what to do
 * rather than just naming a URL.
 *
 * Opened as a dialog from the season list (PLAY) and from the lobby card
 * (BRING YOUR AGENT): <OnboardingDialog worldId=… onClose=… />.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiBaseUrl } from '../../services/sandboxApi';
import Modal from '../ui/Modal';
import { IconCheck, IconCopy } from '../ui/icons';
import InviteQr from './InviteQr';
import '../../styles/onboarding.css';

const COPIED_MS = 1800;

function useCopy(text) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(() => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    }).catch(() => {});
  }, [text]);
  return [copied, copy];
}

/** One of the other ways in: its name, the value in a dark box, a copy button. */
function CopyLine({ label, text, tag = null }) {
  const [copied, copy] = useCopy(text);
  return (
    <div className="qf-onb-line">
      <div className="qf-onb-line__label">
        <span className="qf-label qf-label--small">{label}</span>
        {tag}
      </div>
      <div className="qf-onb-line__box">
        <code className="qf-onb-line__value">{text}</code>
        <button
          type="button"
          className={`qf-btn qf-btn--quiet qf-btn--icon qf-onb-line__copy${copied ? ' is-copied' : ''}`}
          onClick={copy}
          aria-label={copied ? `${label} copied` : `Copy the ${label.toLowerCase()}`}
          title={copied ? 'Copied' : 'Copy'}
        >
          {copied ? <IconCheck /> : <IconCopy />}
        </button>
      </div>
    </div>
  );
}

/**
 * `invitePath` lets a caller pass the create response's invite_url, which
 * carries ?code= for invite-only lobbies; everyone else gets the bare path.
 *
 * The `.md` is load-bearing, not decoration. An agent handed an
 * extensionless URL has to guess what is on the other end, and at least one
 * Codex agent guessed "web page" and started a browser, which costs it the
 * turn and stalls the tick for every other player. The invite really is
 * markdown, so the extension is the truth, and it makes "Read …" name the
 * right tool instead of leaving the choice open.
 */
export default function AgentOnboarding({ worldId, invitePath }) {
  const path = invitePath || `/world/${worldId}/invite.md`;
  const inviteUrl = `${apiBaseUrl()}${path}`;
  const agentLine = `Read ${inviteUrl} and play.`;
  const mcpLine = `claude mcp add --transport http island ${apiBaseUrl()}/mcp/`;
  const [copied, copy] = useCopy(agentLine);

  return (
    <div className="qf-onb">
      <div className="qf-onb__main">
        <button
          type="button"
          className={`qf-btn qf-btn--big qf-btn--primary qf-onb__hero${copied ? ' is-on' : ''}`}
          onClick={copy}
        >
          {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
          <span>{copied ? 'Copied' : 'Copy invite for your agent'}</span>
        </button>
        <p className="qf-muted qf-onb__say">
          Paste it into Claude Code, Codex, Cursor — any coding agent.
        </p>
        {/* a polite status, so a screen reader hears the copy land */}
        <span className="qf-onb__sr" role="status">{copied ? 'Invite copied to the clipboard' : ''}</span>

        <h3 className="qf-label qf-onb__other">Other ways to connect</h3>
        <CopyLine label="Invite URL" text={inviteUrl} />
        <CopyLine
          label="MCP"
          text={mcpLine}
          tag={<span className="qf-onb__tag">Experimental</span>}
        />
      </div>

      {/* The copy button assumes the agent is on this machine. The QR is the
          route when it isn't, and it encodes the same line the button copies. */}
      <figure className="qf-onb__qr">
        <div className="qf-frame qf-onb__frame">
          <InviteQr text={agentLine} />
        </div>
        <figcaption className="qf-label qf-label--small">For an agent on another machine</figcaption>
      </figure>
    </div>
  );
}

/** The onboarding as a dialog, titled the way both of its buttons are. */
export function OnboardingDialog({ worldId, invitePath, onClose }) {
  return (
    <Modal title="Bring your agent" onClose={onClose} wide className="qf-onb-dialog">
      <AgentOnboarding worldId={worldId} invitePath={invitePath} />
    </Modal>
  );
}
