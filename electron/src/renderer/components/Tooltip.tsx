import { useState, type ReactNode } from "react";

/**
 * Accessible tooltip.
 *
 * CSS-driven (see `styles/components/_tooltip.css`) so it costs no JS to show,
 * but wrapped in a component so every call site behaves identically.
 */
export function Tooltip({
  label,
  children,
  side = "right",
}: {
  label: string;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const [visible, setVisible] = useState(false);

  return (
    <span
      className="tooltip-host"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      {visible && label ? (
        <span role="tooltip" className={`tooltip tooltip--${side}`}>
          {label}
        </span>
      ) : null}
    </span>
  );
}
