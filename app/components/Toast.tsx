"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ToastType = "error" | "success" | "info";

export type ToastMessage = {
  id: string;
  type: ToastType;
  message: string;
};

type ToastInput = {
  type?: ToastType;
  message: string;
};

type ToastProps = {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
};

const TOAST_TIMEOUT_MS = 5000;

export function useToast() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const timeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const nextId = useRef(0);

  const dismissToast = useCallback((id: string) => {
    const timeout = timeouts.current[id];
    if (timeout) {
      clearTimeout(timeout);
      delete timeouts.current[id];
    }

    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(
    ({ message, type = "info" }: ToastInput) => {
      const id = `toast-${Date.now()}-${nextId.current}`;
      nextId.current += 1;

      setToasts((current) => [...current, { id, type, message }]);
      timeouts.current[id] = setTimeout(() => {
        dismissToast(id);
      }, TOAST_TIMEOUT_MS);

      return id;
    },
    [dismissToast],
  );

  useEffect(() => {
    return () => {
      Object.values(timeouts.current).forEach(clearTimeout);
    };
  }, []);

  return { toasts, showToast, dismissToast };
}

export function Toast({ toasts, onDismiss }: ToastProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div className={`toast ${toast.type}`} key={toast.id} role="status">
          <div className="toast-content">
            <div className="toast-type">{toast.type}</div>
            <div className="toast-message">{toast.message}</div>
          </div>
          <button
            className="toast-close"
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
