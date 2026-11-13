/**
 * A row of tabs. The caller owns which one is selected and renders the
 * panel; `panelProps(id)` gives that panel the matching ARIA wiring.
 *
 *   const tabs = [{ id: 'odds', label: 'Odds' }, { id: 'bets', label: 'Your bets', badge: 2 }];
 *   <Tabs tabs={tabs} value={tab} onChange={setTab} label="Market" />
 *   <div {...tabPanelProps('market', tab)}>…</div>
 */

import { useId, useRef } from 'react';

export function tabPanelProps(group, id) {
  return {
    role: 'tabpanel',
    id: `${group}-panel-${id}`,
    'aria-labelledby': `${group}-tab-${id}`,
  };
}

export default function Tabs({
  tabs, value, onChange, label, group, className = '',
}) {
  const auto = useId();
  const name = group || auto;
  const refs = useRef({});

  // Arrow keys move along the row, Home and End jump to its ends.
  const onKeyDown = (e) => {
    const i = tabs.findIndex((t) => t.id === value);
    let next = null;
    if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    e.preventDefault();
    onChange(next.id);
    refs.current[next.id]?.focus();
  };

  return (
    <div className={`qf-tabs ${className}`} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.id}
          ref={(el) => { refs.current[t.id] = el; }}
          type="button"
          role="tab"
          id={`${name}-tab-${t.id}`}
          aria-controls={`${name}-panel-${t.id}`}
          aria-selected={t.id === value}
          tabIndex={t.id === value ? 0 : -1}
          className="qf-tab"
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.badge != null && t.badge !== '' && (
            <span className={`qf-tab__badge ${t.badgeTone ? `qf-tab__badge--${t.badgeTone}` : ''}`}>{t.badge}</span>
          )}
        </button>
      ))}
    </div>
  );
}
