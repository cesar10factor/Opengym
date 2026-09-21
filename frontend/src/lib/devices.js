// Pure helpers for the "Devices" section in Settings (GET/DELETE /api/devices live in
// lib/api.js). No DOM, no network — just the two judgement calls the UI and its copy need to
// agree on: can this device be removed, and what do we call it in a list.
import { dateLocale, t } from './i18n-core.js'

// A profile needs at least one passkey or nobody could ever sign in again — so removal is only
// ever offered when there is more than one device. Kept in one place so the disabled row's
// explanation and the actual gate can't drift apart.
export const canRemove = devices => Array.isArray(devices) && devices.length > 1

// Short human label built from `created` (an ISO timestamp, or null for a credential that
// predates the field — see api/devices.integration.test.js). `now` is accepted for a stable
// signature/testability even though the label doesn't currently need "relative to when".
export function deviceLabel(device, now = Date.now()) {
  if (!device) return ''
  const raw = device.created
  if (!raw) return t('Added before this was tracked')
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return t('Added before this was tracked')
  return t('Added {0}', d.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'long', year: 'numeric' }))
}
