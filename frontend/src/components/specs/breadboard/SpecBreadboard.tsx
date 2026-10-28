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
    const affordances = section.affordances.filter((row) => row.placeIds.includes(place.id))
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
        const color = 'hsl(var(--muted-foreground))'
        edges.push({
          id: `${row.id}-${kind}-${target}`,
          source: sourceNode,
          target: targetNode,
          sourceHandle: `${row.id}:out`,
          targetHandle: `${target}:in`,
          type: 'smoothstep',
          style: {
            stroke: color,
            strokeWidth: kind === 'out' ? 1.5 : 1.25,
            ...(kind === 'return' ? { strokeDasharray: '6 4' } : {}),
          },
          markerEnd: { type: MarkerType.ArrowClosed, color },
        })
      }
    }
  }
  return { nodes, edges }
}

export function SpecBreadboard({ projection }: { projection: SpecBreadboardProjection }) {
  const [selectedId, setSelectedId] = useState<'current' | 'target' | null>(null)
  if (projection.status === 'absent') return null
  if (projection.status === 'invalid') {
    return (
      <Card className="p-6" role="alert">
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
  availableIds: ('current' | 'target')[]
  onSelect: (id: 'current' | 'target') => void
}) {
  const { nodes, edges } = useMemo(() => flowElements(section), [section])
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex gap-1" aria-label="Breadboard version">
          {availableIds.map((id) => (
            <Button
              key={id}
              variant={section.id === id ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => onSelect(id)}
            >
              {id === 'current' ? 'Current' : 'Target'}
            </Button>
          ))}
        </div>
        <div className="flex gap-3 text-xs text-muted-foreground" aria-label="Wire legend">
          <span>→ wires out</span>
          <span>⇢ returns to</span>
        </div>
      </div>
      <div className="h-[70vh] min-h-[32rem] overflow-hidden rounded-md border bg-background">
        <FlowCanvas
          nodes={nodes}
          edges={edges}
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
