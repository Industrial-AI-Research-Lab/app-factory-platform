import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * Deep-link preselect for config pages: reads a query param (?agent= / ?server=)
 * and, once the list has rendered a card marked data-preselect="<value>", scrolls
 * it into view and briefly highlights it. Returns [wanted, highlighted] — the
 * caller adds a ring while a card's value equals `highlighted`.
 *
 * `ready` gates the effect until the list has loaded, so the target element exists
 * when we query for it (the fetch resolves after the first render).
 */
export default function usePreselectEntity(param, ready) {
  const [searchParams] = useSearchParams()
  const wanted = searchParams.get(param) || ''
  const [highlighted, setHighlighted] = useState('')

  useEffect(() => {
    if (!wanted || !ready) return undefined
    const escaped = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(wanted) : wanted
    const el = document.querySelector(`[data-preselect="${escaped}"]`)
    if (!el) return undefined
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlighted(wanted)
    const t = setTimeout(() => setHighlighted(''), 2400)
    return () => clearTimeout(t)
  }, [wanted, ready])

  return [wanted, highlighted]
}
