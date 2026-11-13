/**
 * The knobs for opening a lobby: roster size, turn deadline, filler brains,
 * seed, privacy. A dialog opened from the season list's OPEN A LOBBY.
 *
 * POST /world/new is unauthenticated by default and whoever calls it becomes
 * that season's host, so this is a visitor affordance, not an admin one. (An
 * operator-only server refuses it, and the season list hides the button in
 * that case.)
 */

import { useId, useState } from 'react';
import { useSandbox } from '../../context/SandboxContext';
import Modal from '../ui/Modal';
import { IconCheck, IconDown } from '../ui/icons';
import '../../styles/landing.css';

const DEADLINES = [
  { v: 5, label: '5s — scripted rehearsal' },
  { v: 15, label: '15s — fast agents' },
  { v: 30, label: '30s — coding agents' },
  { v: 45, label: '45s — coding agents, relaxed' },
  { v: 90, label: '90s — deep thinkers' },
];

/** One line of the form: its name on the left, the control on the right. */
function Field({ id, label, children }) {
  return (
    <div className="qf-land-field">
      <label className="qf-land-field__label" htmlFor={id}>{label}</label>
      <div className="qf-land-field__control">{children}</div>
    </div>
  );
}

export default function OpenLobbyForm({ onClose }) {
  const { newSeason } = useSandbox();
  const uid = useId();
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
      onClose?.();
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <>
      <button type="button" className="qf-btn qf-btn--quiet" onClick={onClose} disabled={busy}>
        Cancel
      </button>
      <button
        type="submit"
        form={`${uid}-form`}
        className={`qf-btn qf-btn--primary${busy ? ' is-busy' : ''}`}
        disabled={busy}
      >
        {busy ? 'Opening…' : 'Open lobby'}
      </button>
    </>
  );

  return (
    <Modal title="Open a lobby" onClose={busy ? undefined : onClose} wide footer={footer}>
      <form
        id={`${uid}-form`}
        className="qf-land-form"
        onSubmit={(e) => { e.preventDefault(); if (!busy) create(); }}
      >
        <Field id={`${uid}-pool`} label="Roster size">
          <input
            id={`${uid}-pool`}
            className="qf-land-input qf-land-input--num"
            type="number"
            min="2"
            max="20"
            value={poolSize}
            onChange={(e) => setPoolSize(e.target.value)}
          />
        </Field>
        <Field id={`${uid}-deadline`} label="Turn deadline">
          <span className="qf-land-select">
            <select
              id={`${uid}-deadline`}
              className="qf-land-input"
              value={deadline}
              onChange={(e) => setDeadline(Number(e.target.value))}
            >
              {DEADLINES.map(({ v, label }) => (
                <option key={v} value={v}>{label}</option>
              ))}
            </select>
            <IconDown className="qf-land-select__caret" />
          </span>
        </Field>
        <Field id={`${uid}-brain`} label="Hosted fillers">
          <span className="qf-land-select">
            <select
              id={`${uid}-brain`}
              className="qf-land-input"
              value={brain}
              onChange={(e) => setBrain(e.target.value)}
            >
              <option value="llm">LLM brains</option>
              <option value="policy">Scripted (free, instant)</option>
            </select>
            <IconDown className="qf-land-select__caret" />
          </span>
        </Field>
        <Field id={`${uid}-seed`} label="Seed">
          <input
            id={`${uid}-seed`}
            className="qf-land-input"
            type="text"
            inputMode="numeric"
            placeholder="random"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
          />
        </Field>
        <label className="qf-land-check">
          <input
            type="checkbox"
            className="qf-land-check__input"
            checked={inviteOnly}
            onChange={(e) => setInviteOnly(e.target.checked)}
          />
          <span className="qf-land-check__box" aria-hidden>{inviteOnly && <IconCheck size={13} />}</span>
          <span className="qf-land-check__text">Invite-only — joins need the code from the invite link</span>
        </label>
      </form>
    </Modal>
  );
}
