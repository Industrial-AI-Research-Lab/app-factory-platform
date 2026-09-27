// Simple global notify utility using a CustomEvent so any component can trigger toasts
// Usage: import { notify } from './utils_notify';
// notify({ title: 'Invalid API key', message: 'Open Settings to update.', variant: 'error', action: { label: 'Open Settings', href: '/settings' } })

export function notify(detail) {
  try {
    const evt = new CustomEvent('app-notify', { detail })
    window.dispatchEvent(evt)
  } catch (e) {
    // no-op
  }
}

export function notifyClear() {
  try {
    const evt = new CustomEvent('app-notify-clear')
    window.dispatchEvent(evt)
  } catch (e) {
    // no-op
  }
}
