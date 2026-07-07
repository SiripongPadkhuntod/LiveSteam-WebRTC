import React from "react";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className = "", label, error, ...props }, ref) => {
    return (
      <div className={`input-wrapper ${className}`}>
        {label && <label className="input-label">{label}</label>}
        <input ref={ref} className="input-field" {...props} />
        {error && <span className="text-sm" style={{ color: "var(--danger)" }}>{error}</span>}
      </div>
    );
  }
);
Input.displayName = "Input";
