import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  MarkerType,
  useInternalNode,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
} from '@xyflow/react'
import { shallow } from 'zustand/shallow'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { Issue } from '@/types/api'
import { FlowCanvas } from '@/components/flow/FlowCanvas'
import type {
  SpecBreadboardSlice,
  SpecBreadboardProjection,
  SpecBreadboardSection,
} from '@/lib/spec-breadboard'
import { BreadboardPlaceNode, type BreadboardPlaceData } from './BreadboardPlaceNode'
import { breadboardDimensions } from './layout'
import { BreadboardEdge, type BreadboardWire } from './BreadboardEdge'

const nodeTypes = { breadboardPlace: BreadboardPlaceNode }
const edgeTypes = { breadboard: BreadboardEdge }

function flowElements(section: SpecBreadboardSection, slice?: SpecBreadboardSlice) {
  let rows = section.affordances
  if (slice) {
    const ids = new Set(slice.affordanceIds)
    rows = rows.filter((row) => ids.has(row.id))
  }
  const ownerByTarget = new Map<string, string>()
  for (const place of section.places) ownerByTarget.set(place.id, place.id)
  for (const row of rows) ownerByTarget.set(row.id, row.placeIds[0])

  const visiblePlaces = section.places.filter((place) =>
    rows.some((row) => row.placeIds.includes(place.id))
  )
  const visiblePlaceIds = new Set(visiblePlaces.map((place) => place.id))
  const nodes: Node[] = visiblePlaces.map((place) => {
    const affordances = rows.filter((row) => row.placeIds.includes(place.id))
    const data: BreadboardPlaceData = {
      place,
      affordances,
      layoutHeight:
        100 +
        affordances.reduce(
          (height, row) =>
            height + 75 + Math.floor((row.label.length + (row.owner?.length ?? 0)) / 45) * 20,
          0
        ),
    }
    return { id: place.id, type: 'breadboardPlace', position: { x: 0, y: 0 }, data }
  })

  const edges: BreadboardWire[] = []
  for (const row of rows) {
    for (const [kind, targets] of [
      ['out', row.wiresOut],
      ['return', row.returnsTo],
    ] as const) {
      for (const target of targets) {
        const sourceNode = ownerByTarget.get(row.id)
        if (!sourceNode) {
          throw new Error(`Breadboard wire ${row.id} has no place owner.`)
        }
        const targetNode = ownerByTarget.get(target)
        if (!targetNode || !visiblePlaceIds.has(targetNode)) continue
        const color = 'hsl(var(--foreground) / 0.75)'
        edges.push({
          id: `${row.id}-${kind}-${target}`,
          source: sourceNode,
          target: targetNode,
          sourceHandle: row.id,
          targetHandle: target,
          type: 'breadboard',
          data: { kind },
          style: {
            stroke: color,
            strokeWidth: 1.5,
            ...(kind === 'return' ? { strokeDasharray: '6 4' } : {}),
          },
          markerEnd: { type: MarkerType.ArrowClosed, color },
        })
      }
    }
  }
  return { nodes, edges }
}

function routeBreadboardEdges(edges: Edge[], nodes: Node[]) {
  const positions = new Map(nodes.map((node) => [node.id, node.position.x]))
  return edges.map((edge) => {
    const sourceX = positions.get(edge.source)
    const targetX = positions.get(edge.target)
    if (sourceX === undefined || targetX === undefined) {
      throw new Error(`Breadboard edge ${edge.id} has no laid-out endpoint.`)
    }
    const backward = targetX < sourceX
    const sameColumn = sourceX === targetX
    const opposite = { left: 'right', right: 'left' } as const
    const outgoingSource = backward || sameColumn ? 'left' : 'right'
    const outgoingTarget = backward ? 'right' : 'left'
    const alternate = edge.data?.kind === 'return' && sameColumn
    const sourceSide = alternate ? opposite[outgoingSource] : outgoingSource
    const targetSide = alternate ? opposite[outgoingTarget] : outgoingTarget
    return {
      ...edge,
      sourceHandle: `${edge.sourceHandle}:out-${sourceSide}`,
      targetHandle: `${edge.targetHandle}:in-${targetSide}`,
    }
  })
}

export function SpecBreadboard({
  projection,
  issues,
  issueHref,
}: {
  projection: SpecBreadboardProjection
  issues: Issue[]
  issueHref: (issueId: string) => string
}) {
  const [selectedId, setSelectedId] = useState<SpecBreadboardSection['id'] | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  if (projection.status === 'absent') return null
  if (projection.status === 'invalid') {
    return (
      <Card className="border-destructive p-6" role="alert">
        <div className="font-medium text-destructive">Invalid breadboard</div>
        <div className="mt-2 text-sm text-foreground">{projection.message}</div>
      </Card>
    )
  }

  const sliceId = searchParams.get('slice')
  const slice = projection.slices.find((candidate) => candidate.id === sliceId)
  if (sliceId && !slice) {
    return (
      <Card className="p-6">
        <div className="font-medium text-destructive">Unknown slice: {sliceId}</div>
      </Card>
    )
  }
  const linkedIssue = slice?.issueId
    ? issues.find((issue) => issue.id === slice.issueId)
    : undefined
  const selected =
    projection.sections.find((section) => section.id === selectedId) ??
    projection.sections.find((section) => section.id === 'target') ??
    projection.sections[0]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="breadboard-slice" className="text-sm font-medium">
          Slice
        </label>
        <select
          id="breadboard-slice"
          aria-label="Slice"
          className="h-8 max-w-full rounded-md border border-input bg-background px-2 text-sm"
          value={sliceId ?? ''}
          onChange={(event) => {
            const next = new URLSearchParams(searchParams)
            if (event.target.value) next.set('slice', event.target.value)
            else next.delete('slice')
            setSearchParams(next, { replace: true })
          }}
        >
          <option value="">All slices</option>
          {projection.slices.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.id}: {candidate.title}
            </option>
          ))}
        </select>
        {slice && (
          <Badge variant="secondary">
            Showing {slice.id}: {slice.title}
          </Badge>
        )}
        {linkedIssue && (
          <a className="text-sm text-primary hover:underline" href={issueHref(linkedIssue.id)}>
            <Badge variant="outline">{linkedIssue.status.replace(/_/g, ' ')}</Badge>
            <span className="ml-1 font-mono text-xs">{linkedIssue.id}</span>
          </a>
        )}
        {slice && !linkedIssue && (
          <span className="text-sm text-muted-foreground">
            {slice.issueId ? `Issue ${slice.issueId} unavailable` : 'No linked issue'}
          </span>
        )}
      </div>
      <BreadboardSectionView
        key={`${selected.id}:${sliceId ?? 'all'}`}
        section={selected}
        slice={slice}
        availableIds={projection.sections.map((candidate) => candidate.id)}
        onSelect={setSelectedId}
      />
    </div>
  )
}

function BreadboardSectionView({
  section,
  slice,
  availableIds,
  onSelect,
}: {
  section: SpecBreadboardSection
  slice?: SpecBreadboardSlice
  availableIds: SpecBreadboardSection['id'][]
  onSelect: (id: SpecBreadboardSection['id']) => void
}) {
  const [focusedPlaceId, setFocusedPlaceId] = useState('')
  const [graphSize, setGraphSize] = useState({ width: 0, height: 0 })
  const [canvasWidth, setCanvasWidth] = useState(0)
  const canvasRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(([entry]) => setCanvasWidth(entry.contentRect.width))
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])
  const { nodes, edges } = useMemo(() => flowElements(section, slice), [section, slice])
  const layoutEdges = useMemo(() => edges.filter((edge) => edge.data?.kind === 'out'), [edges])
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1" role="group" aria-label="Breadboard version">
          {availableIds.map((id) => (
            <Button
              key={id}
              variant={section.id === id ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={section.id === id}
              onClick={() => onSelect(id)}
            >
              {id === 'current' ? 'Current' : 'Target'}
            </Button>
          ))}
        </div>
        <div
          className="flex gap-3 text-xs text-muted-foreground"
          role="group"
          aria-label="Wire legend"
        >
          <span className="flex items-center gap-1">
            <svg width="24" height="6" aria-hidden="true">
              <line
                x1="0"
                y1="3"
                x2="24"
                y2="3"
                stroke="hsl(var(--foreground) / 0.75)"
                strokeWidth="1.5"
              />
            </svg>
            Wires Out
          </span>
          <span className="flex items-center gap-1">
            <svg width="24" height="6" aria-hidden="true">
              <line
                x1="0"
                y1="3"
                x2="24"
                y2="3"
                stroke="hsl(var(--foreground) / 0.75)"
                strokeWidth="1.5"
                strokeDasharray="6 4"
              />
            </svg>
            Returns To
          </span>
        </div>
      </div>
      {nodes.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <label htmlFor="breadboard-place" className="font-medium">
            Read a place
          </label>
          <select
            id="breadboard-place"
            className="h-8 max-w-full rounded-md border border-input bg-background px-2"
            value={focusedPlaceId}
            onChange={(event) => setFocusedPlaceId(event.target.value)}
          >
            <option value="">Choose a place</option>
            {nodes.map((node) => {
              const place = section.places.find((candidate) => candidate.id === node.id)
              if (!place) throw new Error(`Breadboard place ${node.id} is missing.`)
              return (
                <option key={place.id} value={place.id}>
                  {place.id}: {place.name}
                </option>
              )
            })}
          </select>
          <span className="text-muted-foreground">
            Choose a place to zoom in. Drag to pan; use Fit View for the overview.
          </span>
        </div>
      )}
      <div
        ref={canvasRef}
        className="overflow-hidden rounded-md border bg-background"
        style={{
          height:
            graphSize.width && canvasWidth
              ? `min(max(18rem, calc(100dvh - 23rem)), ${Math.max(288, ((canvasWidth - 48) * graphSize.height) / graphSize.width + 48)}px)`
              : 'max(18rem, calc(100dvh - 23rem))',
        }}
      >
        {nodes.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">
            No affordances for this slice in {section.id === 'current' ? 'Current' : 'Target'}.
          </div>
        ) : (
          <FlowCanvas
            nodes={nodes}
            edges={edges}
            layoutEdges={layoutEdges}
            routeEdges={routeBreadboardEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            dimensions={breadboardDimensions}
            direction="LR"
            minimumZoom={0.1}
            minimumFitZoom={0.1}
            fitPadding="24px"
            fitView={false}
            defaultZoom={1}
            alignColumns
            onNodeSelect={setFocusedPlaceId}
            showControls
          >
            <BreadboardViewport onGraphSize={setGraphSize} />
            <BreadboardFocus placeId={focusedPlaceId} />
          </FlowCanvas>
        )}
      </div>
    </div>
  )
}

function BreadboardViewport({
  onGraphSize,
}: {
  onGraphSize: (size: { width: number; height: number }) => void
}) {
  const nodes = useStore((state) => [...state.nodeLookup.values()], shallow)
  const { setViewport } = useReactFlow()
  const initialized = useRef(false)
  useEffect(() => {
    if (!nodes.length || nodes.some((node) => !node.measured.width || !node.measured.height)) return
    const bounds = nodes.map((node) => {
      const { width, height } = node.measured
      if (width === undefined || height === undefined)
        throw new Error(`Breadboard place ${node.id} has no measured bounds.`)
      return {
        x: node.internals.positionAbsolute.x,
        y: node.internals.positionAbsolute.y,
        width,
        height,
      }
    })
    const left = Math.min(...bounds.map((node) => node.x))
    const top = Math.min(...bounds.map((node) => node.y))
    const right = Math.max(...bounds.map((node) => node.x + node.width))
    const bottom = Math.max(...bounds.map((node) => node.y + node.height))
    onGraphSize({ width: right - left, height: bottom - top })
    if (!initialized.current) {
      initialized.current = true
      void setViewport({ x: 32 - left, y: 32 - top, zoom: 1 })
    }
  }, [nodes, onGraphSize, setViewport])
  return null
}

function BreadboardFocus({ placeId }: { placeId: string }) {
  const node = useInternalNode(placeId)
  const { setCenter } = useReactFlow()
  const focused = useRef('')
  useEffect(() => {
    if (!placeId) {
      focused.current = ''
      return
    }
    if (focused.current === placeId) return
    if (!node?.measured?.width || !node.measured.height) return
    focused.current = placeId
    void setCenter(
      node.internals.positionAbsolute.x + node.measured.width / 2,
      node.internals.positionAbsolute.y + Math.min(node.measured.height / 2, 170),
      { zoom: 1, duration: 250 }
    )
  }, [node, placeId, setCenter])
  return null
}
