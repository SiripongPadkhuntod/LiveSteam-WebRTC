import React from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";

export interface ToastProps {
  message: string;
  type?: "success" | "error" | "info";
  visible: boolean;
}

export function Toast({ message, type = "info", visible }: ToastProps) {
  if (!visible) return null;

  return (
    <div className="toast-container">
      <div className={`toast ${type}`}>
        {type === "error" && <AlertCircle size={18} />}
        {type === "success" && <CheckCircle2 size={18} />}
        <span>{message}</span>
      </div>
    </div>
  );
}
