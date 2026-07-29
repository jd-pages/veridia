import type { CSSProperties } from "react";

export type VeridiaLogoTheme = "dark" | "light" | "mono";

const palette: Record<
  VeridiaLogoTheme,
  { primary: string; foreground: string; accent: string }
> = {
  dark: {
    primary: "#E5484D",
    foreground: "#F8FAFC",
    accent: "#C9A86A",
  },
  light: {
    primary: "#8F1D27",
    foreground: "#111827",
    accent: "#C9A86A",
  },
  mono: {
    primary: "currentColor",
    foreground: "currentColor",
    accent: "currentColor",
  },
};

export default function VeridiaLogo({
  theme = "dark",
  size = 40,
  className,
  title,
}: {
  theme?: VeridiaLogoTheme;
  size?: number | string;
  className?: string;
  title?: string;
}) {
  const colors = palette[theme];
  const style = {
    display: "block",
    flex: "0 0 auto",
  } satisfies CSSProperties;

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      style={style}
    >
      {title && <title>{title}</title>}
      <path
        d="M18 7H44L56 19V31M56 40V45L44 57H20L8 45V20L17 11"
        stroke={colors.primary}
        strokeWidth="4"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      <path d="M16 20H25L33 41L29 51L14 20H16Z" fill={colors.primary} />
      <path d="M48 20H39L31 41L35 51L50 20H48Z" fill={colors.foreground} />
      <path
        d="M48 9L54 15"
        stroke={colors.accent}
        strokeWidth="3"
        strokeLinecap="square"
      />
    </svg>
  );
}
