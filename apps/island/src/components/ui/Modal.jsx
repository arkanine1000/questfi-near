/**
 * A dialog over everything else. Escape and a click on the dimmed backdrop
 * close it, focus moves into it when it opens and returns to where it was
 * when it closes, and Tab stays inside it.
 *
 *   <Modal title="How betting works" onClose={close} wide footer={<button …/>}>…</Modal>
 */

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { IconClose } from './icons';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Modal({
  title, onClose, children, footer = null, wide = false, tone = '', className = '',
}) {
  const boxRef = useRef(null);
  const titleId = useId();
  // read through a ref so the effect below runs once per opening, not once
  // per render of a parent that passes a fresh function
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement;
    const box = boxRef.current;
    (box?.querySelector(FOCUSABLE) || box)?.focus();

    const onKey = (e) => {
      if (e.key === 'Escape') {
        // the island's own Escape (leave follow mode) must not also fire
        e.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (e.key !== 'Tab' || !box) return;
      const items = [...box.querySelectorAll(FOCUSABLE)];
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    // capture, so this sees Escape before the window listeners behind it
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, []);

  return createPortal(
    <div
      className="qf-modal"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        ref={boxRef}
        className={`qf-modal__box ${wide ? 'qf-modal__box--wide' : ''} ${tone ? `qf-modal__box--${tone}` : ''} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="qf-modal__head">
          <span id={titleId}>{title}</span>
          <button type="button" className="qf-x" onClick={onClose} aria-label="Close"><IconClose size={14} /></button>
        </div>
        <div className="qf-modal__body">{children}</div>
        {footer && <div className="qf-modal__foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
