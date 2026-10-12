import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import ForceGraph3D from 'react-force-graph-3d'
import type { ForceGraphMethods, GraphData, LinkObject, NodeObject } from 'react-force-graph-3d'
import { Loader2, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { relationshipsApi, getCurrentProjectId } from '@/lib/api'
import {
  RELATIONSHIP_COLORS,
  RELATIONSHIP_HEX_COLORS,
  RELATIONSHIP_LABELS,
} from '@/lib/relationships'
import { cn } from '@/lib/utils'
import { useIssues } from '@/hooks/useIssues'
import { useSpecs } from '@/hooks/useSpecs'
import { useProject } from '@/hooks/useProject'
import { useProjectRoutes } from '@/hooks/useProjectRoutes'
import { useTheme } from '@/contexts/ThemeContext'
import { useWebSocketContext } from '@/contexts/WebSocketContext'
import type { EntityType, Issue, RelationshipType, Spec, WebSocketMessage } from '@/types/api'

interface MapNode {
  /** `${entityType}:${entityId}` */
  id: string
  entityType: EntityType
  entityId: string
  degree: number
}

interface MapLink {
  relationshipType: RelationshipType
}

/** Link as built from relationships, before the simulation swaps ids for node objects */
type TopologyLink = MapLink & { source: string; target: string }

type MapNodeObject = NodeObject<MapNode>
type MapLinkObject = LinkObject<MapNode, MapLink>

type MapEntity = { type: 'issue'; entity: Issue } | { type: 'spec'; entity: Spec }

// Same hues as the `issue` / `spec` Badge variants
const ENTITY_HEX_COLORS: Record<EntityType, string> = {
  issue: '#3b82f6',
  spec: '#a855f7',
}
const DIMMED_ENTITY_COLORS: Record<EntityType, string> = {
  issue: 'rgba(59, 130, 246, 0.15)',
  spec: 'rgba(168, 85, 247, 0.15)',
}
const DIMMED_LINK_COLOR = 'rgba(148, 163, 184, 0.12)'

const RELATIONSHIPS_QUERY_KEY = 'relationship-map'

// Links hold string ids until the simulation replaces them with node objects
function endpointId(endpoint: MapLinkObject['source']): string {
  if (typeof endpoint === 'object') return endpoint.id
  if (endpoint === undefined) throw new Error('Relationship map link has no endpoint')
  return String(endpoint)
}

export default function RelationshipMapPage() {
  const queryClient = useQueryClient()
  const { currentProjectId } = useProject()
  const { paths } = useProjectRoutes()
  const { activeTheme } = useTheme()
  const issuesQuery = useIssues()
  const specsQuery = useSpecs()
  const { connected, subscribe, unsubscribe, addMessageHandler, removeMessageHandler } =
    useWebSocketContext()

  const isProjectSynced = currentProjectId === getCurrentProjectId()
  const relationshipsQuery = useQuery({
    queryKey: [RELATIONSHIPS_QUERY_KEY, currentProjectId],
    queryFn: relationshipsApi.list,
    enabled: !!currentProjectId && isProjectSynced,
  })

  const handleMessage = useCallback(
    (message: WebSocketMessage) => {
      if (message.type === 'relationship_created' || message.type === 'relationship_deleted') {
        queryClient.invalidateQueries({ queryKey: [RELATIONSHIPS_QUERY_KEY, currentProjectId] })
      }
    },
    [queryClient, currentProjectId]
  )

  // Relationship events are only broadcast to 'all' subscribers
  useEffect(() => {
    const handlerId = 'RelationshipMapPage'
    addMessageHandler(handlerId, handleMessage)
    if (connected) {
      subscribe('all')
    }
    return () => {
      removeMessageHandler(handlerId)
      unsubscribe('all')
    }
  }, [connected, subscribe, unsubscribe, addMessageHandler, removeMessageHandler, handleMessage])

  const graphRef = useRef<ForceGraphMethods<MapNode, MapLink> | undefined>(undefined)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [canvasElement, setCanvasElement] = useState<HTMLDivElement | null>(null)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [findValue, setFindValue] = useState('')
  // Unlinked entities are scattered by the charge force and shrink every linked cluster
  // when the camera fits the graph, so they are opt-in.
  const [showUnlinked, setShowUnlinked] = useState(false)

  useEffect(() => {
    if (!canvasElement) return
    const observer = new ResizeObserver(([entry]) => {
      setCanvasSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(canvasElement)
    return () => observer.disconnect()
  }, [canvasElement])

  const entitiesByNodeId = useMemo(() => {
    const map = new Map<string, MapEntity>()
    for (const issue of issuesQuery.issues) {
      map.set(`issue:${issue.id}`, { type: 'issue', entity: issue })
    }
    for (const spec of specsQuery.specs) {
      map.set(`spec:${spec.id}`, { type: 'spec', entity: spec })
    }
    return map
  }, [issuesQuery.issues, specsQuery.specs])

  // Only topology goes into the graph, so content edits (titles, statuses) do not
  // restart the force simulation; card and hover details are read from entitiesByNodeId.
  const { topology, hiddenRelationshipCount, unlinkedCount, relationshipTypeCounts } =
    useMemo(() => {
      const degrees = new Map<string, number>()
      const links: TopologyLink[] = []
      const typeCounts = new Map<RelationshipType, number>()
      let hidden = 0
      for (const rel of relationshipsQuery.data ?? []) {
        const source = `${rel.from_type}:${rel.from_id}`
        const target = `${rel.to_type}:${rel.to_id}`
        // Endpoint is archived or no longer exists; counted and reported, not drawn
        if (!entitiesByNodeId.has(source) || !entitiesByNodeId.has(target)) {
          hidden++
          continue
        }
        links.push({ source, target, relationshipType: rel.relationship_type })
        degrees.set(source, (degrees.get(source) ?? 0) + 1)
        degrees.set(target, (degrees.get(target) ?? 0) + 1)
        typeCounts.set(rel.relationship_type, (typeCounts.get(rel.relationship_type) ?? 0) + 1)
      }
      const allNodes: MapNode[] = Array.from(entitiesByNodeId, ([id, { type, entity }]) => ({
        id,
        entityType: type,
        entityId: entity.id,
        degree: degrees.get(id) ?? 0,
      }))
      const nodes = showUnlinked ? allNodes : allNodes.filter((node) => node.degree > 0)
      nodes.sort((a, b) => a.id.localeCompare(b.id))
      links.sort(
        (a, b) =>
          a.source.localeCompare(b.source) ||
          a.target.localeCompare(b.target) ||
          a.relationshipType.localeCompare(b.relationshipType)
      )
      return {
        topology: JSON.stringify({ nodes, links }),
        hiddenRelationshipCount: hidden,
        unlinkedCount: allNodes.length - degrees.size,
        relationshipTypeCounts: typeCounts,
      }
    }, [relationshipsQuery.data, entitiesByNodeId, showUnlinked])

  // The force graph mutates node/link objects in place, so it gets fresh objects only
  // when the topology string changes.
  const graphData = useMemo(() => JSON.parse(topology) as GraphData<MapNode, MapLink>, [topology])

  const selectedEntity = selectedNodeId ? entitiesByNodeId.get(selectedNodeId) : undefined
  const hoveredEntity = hoveredNodeId ? entitiesByNodeId.get(hoveredNodeId) : undefined
  const focusNodeId = selectedEntity ? selectedNodeId : hoveredEntity ? hoveredNodeId : null

  const focusNeighborhood = useMemo(() => {
    if (!focusNodeId) return null
    const ids = new Set([focusNodeId])
    for (const link of graphData.links) {
      const source = endpointId(link.source)
      const target = endpointId(link.target)
      if (source === focusNodeId) ids.add(target)
      if (target === focusNodeId) ids.add(source)
    }
    return ids
  }, [graphData, focusNodeId])

  // Keep the detail card pinned to the selected node while the camera or simulation moves.
  // Writes straight to the DOM: re-rendering React every frame would be wasted work.
  useEffect(() => {
    if (!selectedEntity || !selectedNodeId) return
    const node = graphData.nodes.find((candidate) => candidate.id === selectedNodeId)
    if (!node) return
    let frame = 0
    const tick = () => {
      const graph = graphRef.current
      const card = cardRef.current
      if (graph && card) {
        const point = graph.graph2ScreenCoords(node.x ?? 0, node.y ?? 0, node.z ?? 0)
        const parent = card.offsetParent as HTMLElement
        const x = Math.min(Math.max(point.x + 24, 16), parent.clientWidth - card.offsetWidth - 16)
        const y = Math.min(
          Math.max(point.y - card.offsetHeight / 2, 16),
          parent.clientHeight - card.offsetHeight - 16
        )
        card.style.transform = `translate(${x}px, ${y}px)`
      }
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [graphData, selectedNodeId, selectedEntity])

  // Fly the camera to a newly selected node
  useEffect(() => {
    if (!selectedNodeId) return
    const node = graphData.nodes.find((candidate) => candidate.id === selectedNodeId)
    if (!node) return
    const x = node.x ?? 0
    const y = node.y ?? 0
    const z = node.z ?? 0
    const ratio = 1 + 160 / (Math.hypot(x, y, z) || 1)
    graphRef.current?.cameraPosition({ x: x * ratio, y: y * ratio, z: z * ratio }, { x, y, z }, 700)
  }, [graphData, selectedNodeId])

  useEffect(() => {
    if (!selectedNodeId) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedNodeId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedNodeId])

  const handleNodeClick = useCallback((node: MapNodeObject) => {
    setSelectedNodeId((current) => (current === node.id ? null : node.id))
  }, [])

  const handleNodeHover = useCallback((node: MapNodeObject | null) => {
    setHoveredNodeId(node ? node.id : null)
  }, [])

  const handleBackgroundClick = useCallback(() => setSelectedNodeId(null), [])

  const handleEngineStop = useCallback(() => {
    if (!selectedNodeId) graphRef.current?.zoomToFit(400, 40)
  }, [selectedNodeId])

  const nodeColor = useCallback(
    (node: MapNodeObject) =>
      !focusNeighborhood || focusNeighborhood.has(node.id)
        ? ENTITY_HEX_COLORS[node.entityType]
        : DIMMED_ENTITY_COLORS[node.entityType],
    [focusNeighborhood]
  )

  const linkTouchesFocus = useCallback(
    (link: MapLinkObject) =>
      endpointId(link.source) === focusNodeId || endpointId(link.target) === focusNodeId,
    [focusNodeId]
  )

  const linkColor = useCallback(
    (link: MapLinkObject) =>
      !focusNodeId || linkTouchesFocus(link)
        ? RELATIONSHIP_HEX_COLORS[link.relationshipType]
        : DIMMED_LINK_COLOR,
    [focusNodeId, linkTouchesFocus]
  )

  const linkWidth = useCallback(
    (link: MapLinkObject) => (linkTouchesFocus(link) ? 1.5 : 0),
    [linkTouchesFocus]
  )

  const linkParticles = useCallback(
    (link: MapLinkObject) => (linkTouchesFocus(link) ? 2 : 0),
    [linkTouchesFocus]
  )

  const findOptions = useMemo(
    () => graphData.nodes.map((node) => ({ node, entity: entitiesByNodeId.get(node.id) })),
    [graphData, entitiesByNodeId]
  )

  const handleFindChange = (value: string) => {
    const match = graphData.nodes.find((node) => node.entityId === value)
    if (match) {
      setSelectedNodeId(match.id)
      setFindValue('')
    } else {
      setFindValue(value)
    }
  }

  const loadError = issuesQuery.error ?? specsQuery.error ?? relationshipsQuery.error
  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center p-6" role="alert">
        <div className="text-center">
          <p className="font-medium text-destructive">Could not load the relationship map</p>
          <p className="mt-1 text-sm text-muted-foreground">{loadError.message}</p>
        </div>
      </div>
    )
  }

  if (issuesQuery.isLoading || specsQuery.isLoading || relationshipsQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading relationship map...
      </div>
    )
  }

  if (entitiesByNodeId.size === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center text-muted-foreground">
          <p className="font-medium text-foreground">No issues or specs yet</p>
          <p className="mt-1 text-sm">
            Create an{' '}
            <Link className="underline" to={paths.issues()}>
              issue
            </Link>{' '}
            or a{' '}
            <Link className="underline" to={paths.specs()}>
              spec
            </Link>{' '}
            to start the relationship map.
          </p>
        </div>
      </div>
    )
  }

  const background = `hsl(${activeTheme.colors.background.split(' ').join(', ')})`

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b p-4">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold">Relationship Map</h1>
          <Badge variant="secondary">{graphData.nodes.length} nodes</Badge>
          <Badge variant="secondary">{graphData.links.length} links</Badge>
          {hiddenRelationshipCount > 0 && (
            <Badge
              variant="outline"
              title="Relationships whose other end is archived or no longer exists are not drawn"
            >
              {hiddenRelationshipCount} to archived or missing entities not shown
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch
              id="relationship-map-show-unlinked"
              checked={showUnlinked}
              onCheckedChange={setShowUnlinked}
            />
            <Label htmlFor="relationship-map-show-unlinked" className="text-sm">
              Show unlinked ({unlinkedCount})
            </Label>
          </div>
          <Input
            aria-label="Find issue or spec by ID"
            placeholder="Find by ID…"
            list="relationship-map-find-options"
            value={findValue}
            onChange={(event) => handleFindChange(event.target.value)}
            className="h-8 w-56"
          />
          <datalist id="relationship-map-find-options">
            {findOptions.map(({ node, entity }) => (
              <option key={node.id} value={node.entityId}>
                {entity?.entity.title}
              </option>
            ))}
          </datalist>
        </div>
      </div>

      <div
        ref={setCanvasElement}
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{ backgroundColor: background }}
        aria-label="3D relationship map. Click a node to show its details, press Escape to close them, or use Find by ID."
        role="region"
      >
        {graphData.nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-muted-foreground">
            No relationships between active issues and specs yet. Turn on “Show unlinked” to see
            them as standalone nodes.
          </div>
        )}
        {graphData.nodes.length > 0 && canvasSize.width > 0 && canvasSize.height > 0 && (
          <ForceGraph3D<MapNode, MapLink>
            ref={graphRef}
            width={canvasSize.width}
            height={canvasSize.height}
            graphData={graphData}
            backgroundColor={background}
            showNavInfo={false}
            nodeVal={(node) => 1 + node.degree}
            nodeRelSize={3}
            nodeOpacity={0.95}
            nodeColor={nodeColor}
            linkColor={linkColor}
            linkOpacity={0.7}
            linkWidth={linkWidth}
            linkDirectionalArrowLength={3}
            linkDirectionalArrowRelPos={1}
            linkDirectionalParticles={linkParticles}
            linkDirectionalParticleWidth={1.5}
            enableNodeDrag={false}
            onNodeClick={handleNodeClick}
            onNodeHover={handleNodeHover}
            onBackgroundClick={handleBackgroundClick}
            onEngineStop={handleEngineStop}
          />
        )}

        <div className="pointer-events-none absolute left-4 top-4 z-10 rounded-lg border bg-card/90 p-3 text-xs text-card-foreground shadow-sm">
          <ul className="space-y-1" aria-label="Legend">
            {(['issue', 'spec'] as const).map((type) => (
              <li key={type} className="flex items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: ENTITY_HEX_COLORS[type] }}
                />
                {type === 'issue' ? 'Issue' : 'Spec'}
              </li>
            ))}
            {(Object.keys(RELATIONSHIP_LABELS) as RelationshipType[]).map((type) => (
              <li key={type} className="flex items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <span className={cn('inline-block h-0.5 w-3', RELATIONSHIP_COLORS[type])} />
                  {RELATIONSHIP_LABELS[type]}
                </span>
                <span className="font-mono text-muted-foreground">
                  {relationshipTypeCounts.get(type) ?? 0}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div
          className="pointer-events-none absolute bottom-4 left-4 z-10 max-w-[60%] truncate rounded-md border bg-card/90 px-3 py-1.5 text-xs text-card-foreground shadow-sm"
          aria-live="polite"
        >
          {hoveredEntity && hoveredEntity !== selectedEntity
            ? `${hoveredEntity.entity.id} · ${hoveredEntity.entity.title}`
            : 'Drag to orbit, scroll to zoom, click a node for details'}
        </div>

        {selectedEntity && (
          <div
            ref={cardRef}
            role="dialog"
            aria-labelledby="relationship-map-card-title"
            className="absolute left-0 top-0 z-20 w-[22rem] max-w-[calc(100%-2rem)] rounded-lg border bg-card p-4 text-card-foreground shadow-lg"
          >
            <div className="flex items-start justify-between gap-2">
              <Badge variant={selectedEntity.type}>
                {selectedEntity.type === 'issue' ? 'Issue' : 'Spec'} {selectedEntity.entity.id}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="Close details"
                onClick={() => setSelectedNodeId(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <h2 id="relationship-map-card-title" className="mt-2 font-semibold leading-snug">
              {selectedEntity.entity.title}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {selectedEntity.type === 'issue' && (
                <Badge variant="outline" className="capitalize">
                  {selectedEntity.entity.status.replace(/_/g, ' ')}
                </Badge>
              )}
              <Badge variant="outline">P{selectedEntity.entity.priority}</Badge>
              <span>
                Updated{' '}
                {formatDistanceToNow(
                  new Date(
                    selectedEntity.entity.updated_at.endsWith('Z')
                      ? selectedEntity.entity.updated_at
                      : selectedEntity.entity.updated_at + 'Z'
                  ),
                  { addSuffix: true }
                )}
              </span>
            </div>
            <p className="mt-3 line-clamp-4 text-sm text-muted-foreground">
              {selectedEntity.entity.content
                .replace(/```[\s\S]*?```/g, ' ')
                .replace(/^\s{0,3}(?:#{1,6}|[-*+]|>|\d+\.)\s+/gm, '')
                .replace(/\s+/g, ' ')
                .trim() || 'No description.'}
            </p>
            <div className="mt-3 flex justify-end">
              <Button asChild size="sm" variant="outline">
                <Link
                  to={
                    selectedEntity.type === 'issue'
                      ? paths.issue(selectedEntity.entity.id)
                      : paths.spec(selectedEntity.entity.id)
                  }
                >
                  Open {selectedEntity.type}
                </Link>
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
