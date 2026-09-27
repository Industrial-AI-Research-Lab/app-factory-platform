import { useMemo } from 'react'
import { annotateEvents, computeFacetView, DEFAULT_FACETS } from '../utils/eventFacets'
import { enrichEvents } from '../utils/eventEnrichment'

/**
 * Filters the (already display-collapsed) event list for the Events tab.
 * Annotation runs once per event-list change; enrichment re-joins the model
 * index when it arrives; the facet view recomputes when the filter state
 * changes. Returns the annotated+enriched list plus the view
 * ({ filtered, counts, teleHidden }). `modelIndex` is optional — absent, rows
 * carry no model and the Model facet is simply empty.
 */
export default function useEventFilter(displayEvents, { level, query, selected, facets = DEFAULT_FACETS, modelIndex = null, configMaps = null }) {
  const annotated = useMemo(() => annotateEvents(displayEvents), [displayEvents])
  const enriched = useMemo(() => enrichEvents(annotated, { modelIndex, configMaps }), [annotated, modelIndex, configMaps])
  const view = useMemo(
    () => computeFacetView(enriched, { level, query, selected, facets }),
    [enriched, level, query, selected, facets],
  )
  return { annotated: enriched, ...view }
}
