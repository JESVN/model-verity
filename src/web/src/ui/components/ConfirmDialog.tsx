import { useEffect, useRef, type ReactNode } from "react";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function TrashIcon() {
  return <svg className="trash-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.5h13M8 5.5V3.7h4v1.8m3 0-.7 11H5.7L5 5.5m3 3v5m4-5v5" /></svg>;
}

export function ConfirmDialog({ open, title, description, confirmLabel = "确认删除", busy, confirmDisabled, error, onCancel, onConfirm }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) { event.preventDefault(); onCancel(); return; }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [busy, onCancel, open]);
  if (!open) return null;
  return <div className="dialog-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <div ref={dialogRef} className="dialog-card" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description">
      <div className="dialog-danger-mark"><TrashIcon /></div>
      <h2 id="confirm-title">{title}</h2>
      <div id="confirm-description" className="dialog-description">{description}</div>
      {error ? <div className="notice-error" role="alert">{error}</div> : null}
      <div className="dialog-actions">
        <button ref={cancelRef} type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" className="btn btn-danger" disabled={busy || confirmDisabled} onClick={onConfirm}>{busy ? "删除中…" : confirmLabel}</button>
      </div>
    </div>
  </div>;
}
