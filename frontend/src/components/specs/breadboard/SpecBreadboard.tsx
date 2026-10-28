import { useMemo, useState } from 'react'
import { MarkerType, type Edge, type Node } from '@xyflow/react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { FlowCanvas } from '@/components/flow/FlowCanvas'
import type { SpecBreadboardProjection, SpecBreadboardSection } from '@/lib/spec-breadboard'
import { BreadboardPlaceNode, type BreadboardPlaceData } from './BreadboardPlaceNode'
import { breadboardDimensions } from './layout'

const nodeTypes = { breadboardPlace: BreadboardPlaceNode }

function flowElements(section: SpecBreadboardSection) {
  const ownerByTarget = new Map<string, string>()
  for (const place of section.places) ownerByTarget.set(place.id, place.id)
  for (const row of section.affordances) ownerByTarget.set(row.id, row.placeIds[0])

  const nodes: Node[] = section.places.map((place) => {
    const affordances = section.affordances.filter((row) => row.placeIds[0] === place.id)
    const data: BreadboardPlaceData = {
      place,
      affordances,
      layoutHeight: 82 + Math.max(affordances.length, 1) * 76,
    }
    return { id: place.id, type: 'breadboardPlace', position: { x: 0, y: 0 }, data }
  })

  const edges: Edge[] = []
  for (const row of section.affordances) {
    for (const [kind, targets] of [
      ['out', row.wiresOut],
      ['return', row.returnsTo],
    ] as const) {
      for (const target of targets) {
        const sourceNode = ownerByTarget.get(row.id)
        const targetNode = ownerByTarget.get(target)
        if (!sourceNode || !targetNode) {
          throw new Error(`Breadboard wire ${row.id} → ${target} has no place owner.`)
        }
        const color =
          kind === 'out' ? 'hsl(var(--foreground) / 0.7)' : 'hsl(var(--muted-foreground) / 0.55)'
        edges.push({
          id: `${row.id}-${kind}-${target}`,
          source: sourceNode,
          target: targetNode,
          sourceHandle: row.id,
          targetHandle: target,
          type: 'smoothstep',
          data: { kind },
          style: {
            stroke: color,
            strokeWidth: kind === 'out' ? 1.5 : 1.25,
            ...(kind === 'return' ? { strokeDasharray: '4 3' } : {}),
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
    const samePlace = edge.source === edge.target
    const sourceSide = backward || samePlace ? 'left' : 'right'
    const targetSide = backward ? 'right' : 'left'
    return {
      ...edge,
      sourceHandle: `${edge.sourceHandle}:out-${sourceSide}`,
      targetHandle: `${edge.targetHandle}:in-${targetSide}`,
    }
  })
}

export function SpecBreadboard({ projection }: { projection: SpecBreadboardProjection }) {
  const [selectedId, setSelectedId] = useState<SpecBreadboardSection['id'] | null>(null)
  if (projection.status === 'absent') return null
  if (projection.status === 'invalid') {
    return (
      <Card className="p-6">
        <div className="font-medium text-destructive">Invalid breadboard</div>
        <div className="mt-2 text-sm text-muted-foreground">{projection.message}</div>
      </Card>
    )
  }

  const selected =
    projection.sections.find((section) => section.id === selectedId) ?? projection.sections[0]
  return (
    <BreadboardSectionView
      key={selected.id}
      section={selected}
      availableIds={projection.sections.map((candidate) => candidate.id)}
      onSelect={setSelectedId}
    />
  )
}

function BreadboardSectionView({
  section,
  availableIds,
  onSelect,
}: {
  section: SpecBreadboardSection
  availableIds: SpecBreadboardSection['id'][]
  onSelect: (id: SpecBreadboardSection['id']) => void
}) {
  const { nodes, edges } = useMemo(() => flowElements(section), [section])
  const layoutEdges = useMemo(() => edges.filter((edge) => edge.data?.kind === 'out'), [edges])
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
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
                stroke="hsl(var(--foreground) / 0.7)"
                strokeWidth="1.5"
              />
            </svg>
            calls / navigates
          </span>
          <span className="flex items-center gap-1">
            <svg width="24" height="6" aria-hidden="true">
              <line
                x1="0"
                y1="3"
                x2="24"
                y2="3"
                stroke="hsl(var(--muted-foreground) / 0.55)"
                strokeWidth="1.25"
                strokeDasharray="4 3"
              />
            </svg>
            returns result to
          </span>
        </div>
      </div>
      <div className="h-[70vh] min-h-[32rem] overflow-hidden rounded-md border bg-background">
        <FlowCanvas
          nodes={nodes}
          edges={edges}
          layoutEdges={layoutEdges}
          routeEdges={routeBreadboardEdges}
          nodeTypes={nodeTypes}
          dimensions={breadboardDimensions}
          direction="LR"
          fitView={false}
          defaultZoom={0.75}
          showControls
        />
      </div>
    </div>
  )
}
