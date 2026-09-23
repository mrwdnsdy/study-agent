/**
 * Kiiku's marigold. `KiikuMark` is the flat product mark; `KiikuBuddy` is the
 * tutor's face in the same flower. Both share one geometry on a 64×64 canvas
 * centred at (32, 32), so they line up wherever one replaces the other.
 */
import type { JSX, ReactNode } from 'react';

export type KiikuMood = 'happy' | 'thinking' | 'cheer';

const PETAL = 'var(--kiiku-petal, #E9A824)';
const INK = '#14343B';
const FACE = '#FFF4DC';
const BLUSH = 'var(--primary-hover, #D9961A)';
/** One petal at 12 o'clock, then every 45° around the centre. */
const PETAL_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315] as const;

function cx(...names: Array<string | undefined>): string {
  return names.filter(Boolean).join(' ');
}

/** `fill` goes through `style` so CSS `var()` values resolve. */
function Petals({ fill, className }: { fill: string; className?: string }): JSX.Element {
  return (
    <g className={className}>
      {PETAL_ANGLES.map((angle) => (
        <ellipse key={angle} cx={32} cy={15.5} rx={6.5} ry={14} transform={`rotate(${angle} 32 32)`} style={{ fill }} />
      ))}
    </g>
  );
}

function Root(props: { size: number; className: string; title?: string; children: ReactNode }): JSX.Element {
  const { size, className, title, children } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      focusable="false"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export interface KiikuMarkProps {
  size?: number;
  /** 'marigold' petals on a currentColor core, or 'ink' (currentColor) petals on a marigold core. */
  variant?: 'ink' | 'marigold';
  className?: string;
  title?: string;
}

export function KiikuMark({ size = 24, variant = 'marigold', className, title }: KiikuMarkProps): JSX.Element {
  const ink = variant === 'ink';
  return (
    <Root size={size} className={cx('kiiku-mark', className)} title={title}>
      <Petals fill={ink ? 'currentColor' : PETAL} />
      <circle cx={32} cy={32} r={9} style={{ fill: ink ? PETAL : 'currentColor' }} />
    </Root>
  );
}

function Face({ mood }: { mood: KiikuMood }): JSX.Element {
  const stroke = { fill: 'none', stroke: INK, strokeLinecap: 'round' } as const;
  if (mood === 'thinking') {
    return (
      <g fill={INK}>
        <circle cx={28} cy={29.5} r={2.4} />
        <circle cx={37} cy={29.5} r={2.4} />
        <path d="M28.5 37 L35.5 36" {...stroke} strokeWidth={2.4} />
      </g>
    );
  }
  if (mood === 'cheer') {
    return (
      <g>
        <path d="M25.5 31 q2 -2.5 4 0" {...stroke} strokeWidth={2.2} />
        <path d="M34.5 31 q2 -2.5 4 0" {...stroke} strokeWidth={2.2} />
        <path d="M27 35 Q32 41.5 37 35 Z" fill={INK} />
        <circle cx={24.5} cy={34.5} r={2} style={{ fill: BLUSH }} opacity={0.6} />
        <circle cx={39.5} cy={34.5} r={2} style={{ fill: BLUSH }} opacity={0.6} />
      </g>
    );
  }
  return (
    <g fill={INK}>
      <circle cx={27.5} cy={30.5} r={2.4} />
      <circle cx={36.5} cy={30.5} r={2.4} />
      <path d="M27.5 35.5 Q32 40 36.5 35.5" {...stroke} strokeWidth={2.4} />
    </g>
  );
}

export interface KiikuBuddyProps {
  size?: number;
  mood?: KiikuMood;
  className?: string;
  title?: string;
}

export function KiikuBuddy({ size = 48, mood = 'happy', className, title }: KiikuBuddyProps): JSX.Element {
  return (
    <Root size={size} className={cx('kiiku-buddy', `kiiku-buddy--${mood}`, className)} title={title}>
      <Petals fill={PETAL} className="kiiku-buddy__petals" />
      <circle cx={32} cy={32} r={13} fill={FACE} />
      <Face mood={mood} />
    </Root>
  );
}
