import type { SVGProps } from "react";

/**
 * Inline SVG icon set.
 *
 * Deliberately not a webfont: an icon font would need its own CSP entry and would
 * flash unstyled text before it loads, which is very visible in a desktop app.
 */

export type IconName =
  | "dashboard"
  | "syllabus"
  | "generate"
  | "review"
  | "session"
  | "socratic"
  | "analytics"
  | "notifications"
  | "settings"
  | "appearance"
  | "dev"
  | "storage"
  | "upload"
  | "download"
  | "trash"
  | "refresh"
  | "check"
  | "close"
  | "warning"
  | "chevron-right"
  | "chevron-down"
  | "plus"
  | "play"
  | "external";

const PATHS: Record<IconName, string> = {
  dashboard: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  syllabus: "M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3zM8 8h7M8 12h7M8 16h4",
  generate: "M12 3v18M3 12h18M6.5 6.5l11 11M17.5 6.5l-11 11",
  review: "M4 6h16v12H4zM4 10h16M9 6v12",
  session: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  socratic: "M4 5h16v11H9l-5 4z",
  analytics: "M4 20V9M10 20V4M16 20v-7M22 20H2",
  notifications: "M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6zM10 19a2 2 0 0 0 4 0",
  settings: "M4 7h10M18 7h2M4 17h4M12 17h8M16 4v6M8 14v6",
  appearance: "M12 3a9 9 0 0 0 0 18c1.7 0 2-1.3 1.2-2.2-.8-.9-.3-2.3 1-2.3H17a4 4 0 0 0 4-4c0-5-4-9.5-9-9.5zM7.5 12a1 1 0 1 0 0-.1M11 8a1 1 0 1 0 0-.1M15.5 9.5a1 1 0 1 0 0-.1",
  dev: "M3 5h18v14H3zM7 10l2.5 2L7 14M12 15h5",
  storage:
    "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  upload: "M12 19V5M6 11l6-6 6 6",
  download: "M12 5v14M6 13l6 6 6-6",
  trash: "M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
  check: "M5 13l4 4L19 7",
  close: "M6 6l12 12M18 6L6 18",
  warning: "M12 4l9 16H3zM12 10v4M12 17v.5",
  "chevron-right": "M9 6l6 6-6 6",
  "chevron-down": "M6 9l6 6 6-6",
  plus: "M12 5v14M5 12h14",
  play: "M7 4l12 8-12 8z",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
