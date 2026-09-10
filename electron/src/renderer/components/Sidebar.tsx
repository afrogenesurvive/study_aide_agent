import { Icon, type IconName } from "../icons";
import { Tooltip } from "./Tooltip";

export type PanelId =
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
  | "storage";

interface NavItem {
  id: PanelId;
  label: string;
  icon: IconName;
  /** Part of the core study loop; the rest are configuration and tooling. */
  primary: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard", primary: true },
  { id: "syllabus", label: "Syllabus", icon: "syllabus", primary: true },
  { id: "generate", label: "Generate", icon: "generate", primary: true },
  { id: "review", label: "Review", icon: "review", primary: true },
  { id: "session", label: "Session", icon: "session", primary: true },
  { id: "socratic", label: "Socratic", icon: "socratic", primary: true },
  { id: "analytics", label: "Analytics", icon: "analytics", primary: true },
  { id: "notifications", label: "Notifications", icon: "notifications", primary: false },
  { id: "settings", label: "Configuration", icon: "settings", primary: false },
  { id: "appearance", label: "Appearance", icon: "appearance", primary: false },
  { id: "dev", label: "Developer", icon: "dev", primary: false },
  { id: "storage", label: "Storage", icon: "storage", primary: false },
];

export function Sidebar({
  active,
  onSelect,
  onResizeStart,
  sidebarRef,
}: {
  active: PanelId;
  onSelect: (panel: PanelId) => void;
  onResizeStart: (event: React.MouseEvent) => void;
  sidebarRef: React.RefObject<HTMLElement>;
}) {
  const primary = NAV_ITEMS.filter((item) => item.primary);
  const secondary = NAV_ITEMS.filter((item) => !item.primary);

  const renderItem = (item: NavItem) => (
    <Tooltip key={item.id} label={item.label}>
      <button
        type="button"
        className={`sidebar-btn${active === item.id ? " sidebar-btn--active" : ""}`}
        onClick={() => onSelect(item.id)}
        aria-current={active === item.id ? "page" : undefined}
      >
        <Icon name={item.icon} />
        <span className="sidebar-btn__label">{item.label}</span>
      </button>
    </Tooltip>
  );

  return (
    <nav className="sidebar" ref={sidebarRef} aria-label="Sections">
      <div className="sidebar-resize-handle" onMouseDown={onResizeStart} role="separator" aria-hidden="true" />
      <div className="sidebar-scroll">
        {primary.map(renderItem)}
        <div className="sidebar-divider" />
        {secondary.map(renderItem)}
      </div>
    </nav>
  );
}
