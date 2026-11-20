import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

/** Small shared controls. Every one is keyboard-operable and has an accessible name. */

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Format a shortcut for tooltips, e.g. shortcut('Z', { mod: true }) -> "⌘Z" or "Ctrl+Z". */
export function shortcut(key: string, options: { mod?: boolean; shift?: boolean } = {}): string {
  const parts: string[] = [];
  if (options.mod) parts.push(isMac ? '⌘' : 'Ctrl');
  if (options.shift) parts.push(isMac ? '⇧' : 'Shift');
  parts.push(key);
  return parts.join(isMac ? '' : '+');
}

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  /** What the button does. Used as the tooltip and the accessible name. */
  label: string;
  /** Shortcut shown in the tooltip. */
  keys?: string;
  active?: boolean;
  children: ReactNode;
}

export function IconButton({ label, keys, active, className, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      title={keys ? `${label} (${keys})` : label}
      className={cx(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors',
        active ? 'bg-accent/20 text-accent' : 'text-dim hover:bg-hover hover:text-ink',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
  keys?: string;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', keys, icon, className, children, title, ...rest }: ButtonProps) {
  const text = typeof children === 'string' ? children : undefined;
  return (
    <button
      type="button"
      title={title ?? (keys && text ? `${text} (${keys})` : undefined)}
      className={cx(
        'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors',
        variant === 'primary' && 'bg-accent text-on-accent hover:bg-accent-strong',
        variant === 'secondary' && 'bg-raised text-ink hover:bg-hover',
        variant === 'ghost' && 'text-dim hover:bg-hover hover:text-ink',
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  onCommit(value: number): void;
  min?: number;
  max?: number;
  step?: number;
  /** Digits after the decimal point when displayed. */
  digits?: number;
  /** Short text shown inside the field before the number, e.g. "X". */
  prefix?: string;
  suffix?: string;
  disabled?: boolean;
  className?: string;
}

function formatNumber(value: number, digits: number): string {
  const f = 10 ** digits;
  return String(Math.round(value * f) / f);
}

/**
 * A number box. Type a value and press Enter (or leave the field) to apply it;
 * the arrow keys change it by one step, or ten steps with Shift.
 */
export function NumberField({
  label,
  value,
  onCommit,
  min = -Infinity,
  max = Infinity,
  step = 1,
  digits = 1,
  prefix,
  suffix,
  disabled,
  className,
}: NumberFieldProps) {
  const shown = formatNumber(value, digits);
  const [draft, setDraft] = useState(shown);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(shown);
  }, [shown]);

  const commit = (text: string) => {
    const parsed = Number(text.replace(',', '.'));
    if (!Number.isFinite(parsed) || text.trim() === '') {
      setDraft(shown);
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    setDraft(formatNumber(clamped, digits));
    if (formatNumber(clamped, digits) !== shown) onCommit(clamped);
  };

  return (
    <label
      className={cx(
        'flex h-8 min-w-0 items-center gap-1 rounded-md bg-raised px-2 focus-within:outline-2 focus-within:outline-accent',
        disabled && 'opacity-40',
        className,
      )}
    >
      {prefix && (
        <span aria-hidden className="shrink-0 text-[11px] font-medium text-faint">
          {prefix}
        </span>
      )}
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        title={label}
        disabled={disabled}
        value={draft}
        className="w-full min-w-0 bg-transparent text-[13px] text-ink outline-none"
        onFocus={(e) => {
          focused.current = true;
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={(e) => {
          focused.current = false;
          commit(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit(e.currentTarget.value);
            e.currentTarget.select();
          } else if (e.key === 'Escape') {
            setDraft(shown);
            e.currentTarget.blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const base = Number(draft.replace(',', '.'));
            const from = Number.isFinite(base) ? base : value;
            const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            commit(String(from + delta));
          }
        }}
      />
      {suffix && (
        <span aria-hidden className="shrink-0 text-[11px] text-faint">
          {suffix}
        </span>
      )}
    </label>
  );
}

interface SelectProps<T extends string | number> {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  className?: string;
}

export function Select<T extends string | number>({ label, value, options, onChange, className }: SelectProps<T>) {
  return (
    <select
      aria-label={label}
      title={label}
      value={String(value)}
      onChange={(e) => {
        const picked = options.find((o) => String(o.value) === e.currentTarget.value);
        if (picked) onChange(picked.value);
      }}
      className={cx('h-8 min-w-0 rounded-md bg-raised px-2 text-[13px] text-ink outline-none hover:bg-hover', className)}
    >
      {options.map((option) => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

interface ColorFieldProps {
  label: string;
  value: string;
  /** Called continuously while the picker is dragged. */
  onInput(value: string): void;
  /** Called when the picker is closed. */
  onDone?(): void;
}

export function ColorField({ label, value, onInput, onDone }: ColorFieldProps) {
  // The native picker needs #rrggbb.
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000';
  return (
    <input
      type="color"
      aria-label={label}
      title={label}
      value={hex}
      onInput={(e) => onInput(e.currentTarget.value)}
      onChange={(e) => onInput(e.currentTarget.value)}
      onBlur={onDone}
      className="h-7 w-7 shrink-0"
    />
  );
}

export function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-line" />;
}

export function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[12px] text-dim">{label}</span>
      {children}
    </div>
  );
}

export function PanelSection({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cx('flex min-h-0 flex-col', className)}>
      <header className="flex h-9 shrink-0 items-center justify-between px-3">
        <h2 id={id} className="text-[11px] font-semibold uppercase tracking-wider text-faint">
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export { cx };
