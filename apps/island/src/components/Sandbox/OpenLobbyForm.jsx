/**
 * The knobs for opening a lobby: roster size, turn deadline, filler brains,
 * seed, privacy.
 *
 * Lives on the landing view. POST /world/new is unauthenticated by default
 * and whoever calls it becomes that season's host — so this is a visitor
 * affordance, not an admin one. (An operator-only server refuses it, and
 * the caller hides this form entirely in that case.)
 */

import { useState } from 'react';
import { useSandbox } from '../../context/SandboxContext';

const DEADLINES = [
  { v: 5, label: '5s — scripted rehearsal' },
  { v: 15, label: '15s — fast agents' },
  { v: 30, label: '30s — coding agents' },
  { v: 45, label: '45s — coding agents, relaxed' },
  { v: 90, label: '90s — deep thinkers' },
];

export default function OpenLobbyForm({ onDone, onCancel, destructive = false }) {
  const { newSeason } = useSandbox();
  const [poolSize, setPoolSize] = useState(10);
  const [deadline, setDeadline] = useState(45);
  const [brain, setBrain] = useState('llm');
  const [inviteOnly, setInviteOnly] = useState(false);
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await newSeason({
        poolSize: Math.min(20, Math.max(2, Number(poolSize) || 10)),
        actionDeadlineS: deadline,
        hostedBrain: brain,
        requireInvite: inviteOnly,
        ...(seed.trim() !== '' ? { seed: Number(seed) } : {}),
      });
      onDone?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {destructive && (
        <p className="qf-warn">
          You are hosting the season on screen — opening a new lobby leaves it.
        </p>
      )}
      <label className="qf-field">
        <span>Roster size</span>
        <input
          type="number" min="2" max="20" value={poolSize}
          onChange={(e) => setPoolSize(e.target.value)}
        />
      </label>
      <label className="qf-field">
        <span>Turn deadline</span>
        <select value={deadline} onChange={(e) => setDeadline(Number(e.target.value))}>
          {DEADLINES.map(({ v, label }) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
      </label>
      <label className="qf-field">
        <span>Hosted fillers</span>
        <select value={brain} onChange={(e) => setBrain(e.target.value)}>
          <option value="llm">LLM brains</option>
          <option value="policy">Scripted (free, instant)</option>
        </select>
      </label>
      <label className="qf-field">
        <span>Seed</span>
        <input
          type="text" inputMode="numeric" placeholder="random" value={seed}
          onChange={(e) => setSeed(e.target.value)}
        />
      </label>
      <label className="qf-check">
        <input
          type="checkbox" checked={inviteOnly}
          onChange={(e) => setInviteOnly(e.target.checked)}
        />
        <span>Invite-only — joins need the code from the invite link</span>
      </label>
      <div className="qf-actions">
        {onCancel && (
          <button type="button" className="qf-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        <button
          type="button" className="qf-btn qf-btn--primary" onClick={create} disabled={busy}
        >
          {busy ? 'Opening…' : 'Open lobby'}
        </button>
      </div>
    </>
  );
}
