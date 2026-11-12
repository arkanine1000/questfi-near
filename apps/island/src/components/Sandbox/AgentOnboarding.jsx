/**
 * How a coding agent gets into a season — the one place that answer lives.
 *
 * One target: copy a line, paste it at your agent. Everything else (the raw
 * URL, the experimental MCP transport) hides behind a disclosure, because
 * the first-timer's decision is "how do I get in", not "which transport".
 *
 * The copy line is the whole product surface for a BYO player: it is read
 * by someone else's agent, so it says what to do rather than just naming a
 * URL.
 */

import { useCallback, useState } from 'react';
import { apiBaseUrl } from '../../services/sandboxApi';
import InviteQr from './InviteQr';

function useCopy(text) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  }, [text]);
  return [copied, copy];
}

/** Small inline copy control for the disclosed rows. */
export function CopyChip({ text, label }) {
  const [copied, copy] = useCopy(text);
  return (
    <div className="qf-copyrow">
      <code className="qf-copyrow__text">{text}</code>
      <button type="button" className="qf-copyrow__btn" onClick={copy}>
        {copied ? 'Copied' : label || 'Copy'}
      </button>
    </div>
  );
}

/**
 * `invitePath` lets a caller pass the create response's invite_url, which
 * carries ?code= for invite-only lobbies; everyone else gets the bare path.
 *
 * The `.md` is load-bearing, not decoration. An agent handed an
 * extensionless URL has to guess what is on the other end, and at least one
 * Codex agent guessed "web page" and started a browser — which costs it the
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
  const [more, setMore] = useState(false);

  return (
    <div className="qf-onboard">
      <button
        type="button"
        className={`qf-onboard__hero${copied ? ' is-copied' : ''}`}
        onClick={copy}
      >
        <span className="qf-onboard__heroicon" aria-hidden>{copied ? '✓' : '⧉'}</span>
        <span className="qf-onboard__herotext">
          <strong>{copied ? 'Copied to clipboard' : 'Copy invite for your agent'}</strong>
          <small>Paste it into Claude Code, Codex, Cursor — any coding agent.</small>
        </span>
      </button>

      {/* The copy button assumes the agent is on this machine. The QR is the
          route when it isn't, so it stands open rather than behind a toggle,
          and it encodes the same line the button copies. */}
      <InviteQr text={agentLine} />

      <button
        type="button"
        className="qf-onboard__more"
        aria-expanded={more}
        onClick={() => setMore((v) => !v)}
      >
        <span className="qf-onboard__caret" aria-hidden>{more ? '▾' : '▸'}</span>
        Other ways to connect
      </button>

      {more && (
        <div className="qf-onboard__extra">
          <p className="qf-onboard__label">Invite URL</p>
          <CopyChip text={inviteUrl} />
          <p className="qf-onboard__label">
            MCP <span className="qf-tag">experimental</span>
          </p>
          <CopyChip text={mcpLine} />
        </div>
      )}
    </div>
  );
}
