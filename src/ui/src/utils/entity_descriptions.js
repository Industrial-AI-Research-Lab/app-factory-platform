/** Display helpers for entity short/long description fields (AppFactory-178). */

export const SHORT_DESCRIPTION_MAX_LEN = 256

export function entityShortDescription(item) {
  const short = String(item?.short_description ?? '').trim()
  const raw = short || String(item?.description ?? '').trim()
  return raw.slice(0, SHORT_DESCRIPTION_MAX_LEN)
}

export function entityLongDescription(item) {
  const long = String(item?.long_description || '').trim()
  return long || String(item?.description || '').trim()
}

/** Form value: null/absent long falls back to legacy; explicit "" stays empty. */
export function entityLongDescriptionForForm(item) {
  if (item?.long_description != null) {
    return String(item.long_description).trim()
  }
  return String(item?.description ?? '').trim()
}

/**
 * Normalize API entity into form short/long/description fields.
 *
 * Migrated docs already have a `long_description` key (incl. ""). Keep form
 * `description` as card text so clear-long can persist "". Unmigrated docs keep
 * the full legacy blob so clear-long can restore into long via save helper.
 */
export function entityDescriptionsForForm(item = {}) {
  const legacy = String(item?.description ?? '').trim()
  const short_description = String(item?.short_description ?? '').trim()
  const long_description = entityLongDescriptionForForm(item)
  const migrated = item?.long_description != null
  const description = migrated
    ? (short_description || legacy.slice(0, SHORT_DESCRIPTION_MAX_LEN))
    : legacy
  return { short_description, long_description, description }
}

/** Mirror short into legacy `description` on UI save so export/API clients stay consistent. */
export function entityDescriptionsForSave({ short_description, long_description, description } = {}) {
  const long = String(long_description ?? '').trim()
  let short = String(short_description ?? '').trim().slice(0, SHORT_DESCRIPTION_MAX_LEN)
  const legacy = String(description ?? '').trim()
  if (!short && long) {
    short = long.slice(0, SHORT_DESCRIPTION_MAX_LEN)
  }
  // Unmigrated only: form still holds full legacy in `description` when user clears long.
  // Migrated create-shaped docs must load via entityDescriptionsForForm so description
  // is already card-length and this restore does not fire.
  if (!long && legacy.length > SHORT_DESCRIPTION_MAX_LEN) {
    const card = short || legacy.slice(0, SHORT_DESCRIPTION_MAX_LEN)
    return {
      short_description: card,
      long_description: legacy,
      description: card,
    }
  }
  return {
    short_description: short,
    long_description: long,
    description: short || long,
  }
}
