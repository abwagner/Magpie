import type { CSSProperties } from "react";

export type IconName =
  | "chevron"
  | "chevronR"
  | "chevronL"
  | "plus"
  | "minus"
  | "x"
  | "check"
  | "square"
  | "pin"
  | "bell"
  | "cog"
  | "filter"
  | "kebab"
  | "expand"
  | "download"
  | "flag"
  | "eye"
  | "bolt"
  | "arrowU"
  | "arrowD"
  | "dot"
  | "layers"
  | "pause"
  | "play"
  | "info"
  | "search"
  | "grid";

const PATHS: Record<IconName, string> = {
  chevron: "M3 5l4 4 4-4",
  chevronR: "M5 3l4 4-4 4",
  chevronL: "M9 3l-4 4 4 4",
  plus: "M7 3v8M3 7h8",
  minus: "M3 7h8",
  x: "M3.5 3.5l7 7M10.5 3.5l-7 7",
  check: "M2.5 7.5l3 3 6-7",
  square: "M2.5 2.5h9v9h-9z",
  pin: "M7 1.5l-2 4-3 .5 3 2.5-1 4 3-2.5 3 2.5-1-4 3-2.5-3-.5z",
  bell: "M3.5 11h7M7 1.5v.5M3 6c0-2.2 1.8-4 4-4s4 1.8 4 4v3l1 2H2l1-2V6z",
  cog: "M7 4.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM7 1v1.5M7 11.5V13M11 7h1.5M1.5 7H3M9.8 4.2l1-1M3.2 9.8l1-1M9.8 9.8l1 1M3.2 4.2l1 1",
  filter: "M2 3h10M4 7h6M6 11h2",
  kebab: "M7 3.5v.01M7 7v.01M7 10.5v.01",
  expand: "M9 1h4v4M5 13H1V9M13 1L9 5M1 13l4-4",
  download: "M7 1v8M3.5 6L7 9.5 10.5 6M2 12h10",
  flag: "M3 1v12M3 2h7l-1.5 2.5L10 7H3",
  eye: "M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4S1 7 1 7zM7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  bolt: "M8 1L3 8h3l-1 5 5-7H7l1-5z",
  arrowU: "M7 11V3M3.5 6.5L7 3l3.5 3.5",
  arrowD: "M7 3v8M3.5 7.5L7 11l3.5-3.5",
  dot: "M7 7h.01",
  layers: "M7 1l5 3-5 3-5-3 5-3zM2 7l5 3 5-3M2 10l5 3 5-3",
  pause: "M4 3v8M10 3v8",
  play: "M4 2v10l8-5-8-5z",
  info: "M7 1a6 6 0 1 0 0 12A6 6 0 0 0 7 1zM7 6v4M7 4v.01",
  search: "M6 1a5 5 0 1 0 3.2 8.8L13 13.6 13.6 13l-3.8-3.8A5 5 0 0 0 6 1z",
  grid: "M2 2h4v4H2zM8 2h4v4H8zM2 8h4v4H2zM8 8h4v4H8z",
};

export interface IconProps {
  name: IconName;
  size?: number;
  stroke?: number;
  style?: CSSProperties;
  className?: string;
  title?: string;
}

export function Icon({ name, size = 12, stroke = 1.5, style, className, title }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}
