import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "home"
  | "gallery"
  | "video"
  | "book"
  | "reference"
  | "star"
  | "sparkles"
  | "download"
  | "settings"
  | "search"
  | "bell"
  | "menu"
  | "minus"
  | "close"
  | "folder"
  | "folderPlus"
  | "refresh"
  | "trash"
  | "grid"
  | "list"
  | "sort"
  | "filter"
  | "image"
  | "file"
  | "database"
  | "clock"
  | "check"
  | "warning"
  | "info"
  | "arrowRight"
  | "chevronRight"
  | "chevronDown"
  | "camera"
  | "rewind"
  | "fastForward"
  | "rewind10"
  | "forward10"
  | "stepBack"
  | "stepForward"
  | "bookmark"
  | "pause"
  | "stop"
  | "wallpaper"
  | "heart"
  | "play"
  | "volume"
  | "volumeOff"
  | "tag"
  | "upload"
  | "external"
  | "hardDrive"
  | "fullscreen"
  | "fullscreenExit"
  | "eye"
  | "eyeOff"
  | "copy"
  | "share";

const paths: Record<IconName, ReactNode> = {
  home: <><path d="M3 11.5 12 4l9 7.5" /><path d="M5 10v10h5v-6h4v6h5V10" /></>,
  gallery: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m3 16 5-5 4 4 3-3 6 6" /><path d="M16.5 8.5h.01" /></>,
  video: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m10 9 5 3-5 3Z" /></>,
  book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5Z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5Z" /></>,
  reference: <><path d="M5 3h14v18H5z" /><path d="M8 7h8M8 11h8M8 15h5" /></>,
  star: <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z" />,
  sparkles: <><path d="m12 3 .8 3.2L16 7l-3.2.8L12 11l-.8-3.2L8 7l3.2-.8Z" /><path d="m18 13 .7 2.3L21 16l-2.3.7L18 19l-.7-2.3L15 16l2.3-.7Z" /><path d="m6 14 .6 1.8 1.9.7-1.9.6L6 19l-.6-1.9-1.9-.6 1.9-.7Z" /></>,
  download: <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 20h14" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  minus: <path d="M5 12h14" />,
  close: <path d="m5 5 14 14M19 5 5 19" />,
  folder: <><path d="M3 6.5h6l2 2h10v10.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 10h18" /></>,
  folderPlus: <><path d="M3 6.5h6l2 2h10v10.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 10h18M12 13v5M9.5 15.5h5" /></>,
  refresh: <><path d="M20 7v5h-5" /><path d="M19 12a7 7 0 1 0-1.8 4.7" /></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  list: <><path d="M9 6h12M9 12h12M9 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>,
  sort: <><path d="M8 4v16M4 8l4-4 4 4" /><path d="M16 20V4M12 16l4 4 4-4" /></>,
  filter: <path d="M3 5h18l-7 8v5l-4 2v-7Z" />,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m4 17 5-5 3 3 2-2 6 5" /></>,
  file: <><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v5h5" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  check: <path d="m4 13 5 5L20 6" />,
  warning: <><path d="m12 3 10 18H2Z" /><path d="M12 9v5M12 18h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
  arrowRight: <path d="m9 5 7 7-7 7" />,
  chevronRight: <path d="m9 5 7 7-7 7" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  camera: <><path d="M4 8h3l1.5-2h7L17 8h3v11H4Z" /><circle cx="12" cy="13.5" r="3.5" /></>,
  rewind: <><path d="m11 7-6 5 6 5Z" /><path d="m19 7-6 5 6 5Z" /></>,
  fastForward: <><path d="m5 7 6 5-6 5Z" /><path d="m13 7 6 5-6 5Z" /></>,
  rewind10: <><path d="M7.2 7.1A7.5 7.5 0 1 1 4.7 13" /><path d="M7.3 3.8v3.5H3.8" /><text x="12" y="15.1" fill="currentColor" stroke="none" fontSize="7.4" fontWeight="800" textAnchor="middle">10</text></>,
  forward10: <><path d="M16.8 7.1A7.5 7.5 0 1 0 19.3 13" /><path d="M16.7 3.8v3.5h3.5" /><text x="12" y="15.1" fill="currentColor" stroke="none" fontSize="7.4" fontWeight="800" textAnchor="middle">10</text></>,
  stepBack: <><path d="M6 6v12" /><path d="m18 7-8 5 8 5Z" /></>,
  stepForward: <><path d="M18 6v12" /><path d="m6 7 8 5-8 5Z" /></>,
  bookmark: <path d="M6 4h12v17l-6-4-6 4Z" />,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" />,
  wallpaper: <><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M8 21h8M12 18v3M4 15l5-5 4 4 3-3 5 5" /></>,
  heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" />,
  play: <path d="m8 5 11 7-11 7Z" />,
  volume: <><path d="M5 10v4h4l5 4V6l-5 4Z" /><path d="M17 9a4 4 0 0 1 0 6M19.5 6.5a7.5 7.5 0 0 1 0 11" /></>,
  volumeOff: <><path d="M5 10v4h4l5 4V6l-5 4Z" /><path d="m18 9 4 4M22 9l-4 4" /></>,
  tag: <><path d="M20 13 13 20 4 11V4h7Z" /><circle cx="8.5" cy="8.5" r="1.3" /></>,
  upload: <><path d="M12 21V9M7 14l5-5 5 5" /><path d="M5 4h14" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v7H4V6h7" /></>,
  hardDrive: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 15h.01M11 15h6" /></>,
  fullscreen: <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></>,
  fullscreenExit: <><path d="M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5" /></>,
  eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.8" /></>,
  eyeOff: <><path d="M3 3l18 18" /><path d="M10.4 6.2A8.8 8.8 0 0 1 12 6c6 0 9.5 6 9.5 6a15 15 0 0 1-2.1 2.8M6.1 6.1C3.8 7.7 2.5 12 2.5 12s3.5 6 9.5 6a9 9 0 0 0 3.1-.5" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  share: <><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5" /></>,
};

type IconProps = SVGProps<SVGSVGElement> & {
  name: IconName;
};

export function Icon({ name, ...props }: IconProps) {
  return (
    <svg
      aria-hidden={props["aria-label"] ? undefined : true}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
