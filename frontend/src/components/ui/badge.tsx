import React from "react";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "live" | "success";
  showDot?: boolean;
}

export function Badge({ children, variant = "default", showDot = false, className = "", ...props }: BadgeProps) {
  return (
    <span className={`badge badge-${variant} ${className}`} {...props}>
      {showDot && <span className="badge-dot" />}
      {children}
    </span>
  );
}
