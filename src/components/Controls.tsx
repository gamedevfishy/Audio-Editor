import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { formatTime, parseTime } from '../lib/format';

/** One tab of a TabbedPanel. `dot` marks tabs whose settings change the output. */
export interface TabSpec {
  id: string;
  label: string;
  dot?: boolean;
  hint?: string;
  aside?: ReactNode;
  content: ReactNode;
}

/** A single panel whose sections are reached through a tab strip — keeps the page calm. */
export function TabbedPanel(props: { tabs: TabSpec[]; label: string }) {
  const [active, setActive] = useState(props.tabs[0].id);
  const tab = props.tabs.find((t) => t.id === active) ?? props.tabs[0];
  const baseId = useId();
  return (
    <section className="panel tabbed">
      <div className="tabstrip" role="tablist" aria-label={props.label}>
        {props.tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${baseId}-${t.id}`}
            aria-selected={t.id === tab.id}
            aria-controls={`${baseId}-panel`}
            className={t.id === tab.id ? 'is-active' : ''}
            onClick={() => setActive(t.id)}
          >
            {t.label}
            {t.dot && <span className="tab-dot" aria-label="(changed)" />}
          </button>
        ))}
      </div>
      <div className="tab-body" role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-${tab.id}`}>
        {(tab.hint || tab.aside) && (
          <div className="tab-head">
            {tab.hint && <p className="hint">{tab.hint}</p>}
            {tab.aside}
          </div>
        )}
        {tab.content}
      </div>
    </section>
  );
}

export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const pct = ((props.value - props.min) / (props.max - props.min)) * 100;
  return (
    <div className={`field ${props.disabled ? 'is-disabled' : ''}`}>
      <div className="field-row">
        <label htmlFor={id}>{props.label}</label>
        <output htmlFor={id}>{props.format(props.value)}</output>
      </div>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        style={{ ['--fill' as string]: `${pct}%` }}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </div>
  );
}

export function Segmented<T extends string | number>(props: {
  label?: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div className={`field ${props.className ?? ''}`}>
      {props.label && (
        <div className="field-row">
          <span className="label">{props.label}</span>
        </div>
      )}
      <div className="segmented" role="radiogroup" aria-label={props.label ?? props.ariaLabel}>
        {props.options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={o.value === props.value}
            disabled={o.disabled}
            className={o.value === props.value ? 'is-active' : ''}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Select<T extends string | number>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <div className="field-row">
        <label htmlFor={id}>{props.label}</label>
      </div>
      <select
        id={id}
        value={String(props.value)}
        onChange={(e) => {
          const match = props.options.find((o) => String(o.value) === e.target.value);
          if (match) props.onChange(match.value);
        }}
      >
        {props.options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function TextField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  suffix?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <div className="field-row">
        <label htmlFor={id}>{props.label}</label>
      </div>
      <div className={`text-input ${props.suffix ? 'has-suffix' : ''}`}>
        <input
          id={id}
          type="text"
          value={props.value}
          placeholder={props.placeholder}
          spellCheck={false}
          onChange={(e) => props.onChange(e.target.value)}
        />
        {props.suffix && <span className="suffix">{props.suffix}</span>}
      </div>
    </div>
  );
}

/** Nudge step from modifier keys: plain 10 ms, Shift 100 ms, Ctrl/Cmd 1 ms. */
export function nudgeStep(e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): number {
  if (e.ctrlKey || e.metaKey) return 0.001;
  if (e.shiftKey) return 0.1;
  return 0.01;
}

/**
 * Text field for a time like 1:23.456 — commits on Enter or blur.
 * ↑/↓ nudge the value (Shift ×10, Ctrl ÷10).
 */
export function TimeField(props: {
  label: string;
  value: number;
  active?: boolean;
  onCommit: (v: number) => void;
  onNudge?: (delta: number) => void;
  onFocus?: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(formatTime(props.value, 3));
  const dirty = useRef(false);

  useEffect(() => {
    if (!dirty.current) setDraft(formatTime(props.value, 3));
  }, [props.value]);

  const commit = () => {
    const v = parseTime(draft);
    dirty.current = false;
    // Reformat now; if the parent changes the value, the effect above updates it again.
    setDraft(formatTime(props.value, 3));
    if (v !== null) props.onCommit(v);
  };

  return (
    <div className={`time-field ${props.active ? 'is-active' : ''}`}>
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        inputMode="decimal"
        value={draft}
        onFocus={(e) => {
          props.onFocus?.();
          e.target.select();
        }}
        onBlur={commit}
        onChange={(e) => {
          dirty.current = true;
          setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'Escape') {
            dirty.current = false;
            setDraft(formatTime(props.value, 3));
            (e.target as HTMLInputElement).blur();
          } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && props.onNudge) {
            e.preventDefault();
            dirty.current = false;
            const step = nudgeStep(e);
            props.onNudge(e.key === 'ArrowUp' ? step : -step);
          }
        }}
      />
    </div>
  );
}
