import { useEffect } from 'react'

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  onConfirm,
  onClose,
  secondaryConfirmLabel,
  onSecondaryConfirm,
  secondaryVariant = 'primary',
}) {
  useEffect(() => {
    const onKey = (e) => {
      if (!open) return
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md mx-4 bg-slate-900 border border-slate-700 rounded-2xl shadow-xl">
        <div className="px-5 pt-5">
          <h2 className="text-slate-100 text-lg font-semibold">{title}</h2>
          {message && (
            <p className="text-slate-300 text-sm mt-2 whitespace-pre-wrap">{message}</p>
          )}
        </div>
        <div className="px-5 py-4 flex items-center justify-end gap-3">
          <button
            className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200"
            onClick={onClose}
          >
            {cancelLabel}
          </button>
          {secondaryConfirmLabel && typeof onSecondaryConfirm === 'function' && (
            <button
              className={
                secondaryVariant === 'danger'
                  ? 'px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white'
                  : secondaryVariant === 'success'
                  ? 'px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white'
                  : 'px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white'
              }
              onClick={onSecondaryConfirm}
            >
              {secondaryConfirmLabel}
            </button>
          )}
          <button
            className={
              variant === 'danger'
                ? 'px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white'
                : 'px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white'
            }
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
