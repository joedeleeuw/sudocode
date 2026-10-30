import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { SpecBreadboardSection } from '@/lib/spec-breadboard'

export type BreadboardPlaceData = {
  place: SpecBreadboardSection['places'][number]
  affordances: SpecBreadboardSection['affordances']
  layoutHeight: number
}

function BreadboardPlaceNodeComponent({ data }: NodeProps<Node<BreadboardPlaceData>>) {
  const { place, affordances } = data
  return (
    <div className="w-[320px] rounded-md border border-border bg-card text-card-foreground shadow-sm">
      <Handle id={`${place.id}:in-left`} type="target" position={Position.Left} />
      <Handle id={`${place.id}:in-right`} type="target" position={Position.Right} />
      <Handle id={`${place.id}:out-left`} type="source" position={Position.Left} />
      <Handle id={`${place.id}:out-right`} type="source" position={Position.Right} />
      <div className="border-b border-border px-4 py-3">
        <div className="font-mono text-[10px] text-muted-foreground">{place.id}</div>
        <div className="inline-block border-b border-foreground text-sm font-medium [overflow-wrap:anywhere]">
          {place.name}
        </div>
        {place.description && (
          <div className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {place.description}
          </div>
        )}
      </div>
      <div>
        {affordances.map((row) => (
          <div
            key={row.id}
            data-affordance-id={row.id}
            className={`relative border-b border-border px-4 py-3 text-sm last:border-b-0 ${row.kind === 'store' ? 'bg-muted/40' : ''}`}
            aria-label={`${row.id}: ${row.label}`}
          >
            <Handle id={`${row.id}:in-left`} type="target" position={Position.Left} />
            <Handle id={`${row.id}:in-right`} type="target" position={Position.Right} />
            <Handle id={`${row.id}:out-left`} type="source" position={Position.Left} />
            <Handle id={`${row.id}:out-right`} type="source" position={Position.Right} />
            <div className="flex items-start gap-2">
              <span className="font-mono font-medium text-foreground">{row.id}</span>
              <span className="min-w-0 text-card-foreground [overflow-wrap:anywhere]">
                {row.label}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {row.placeIds.length > 1 && <span>{row.placeIds.join(' / ')}</span>}
              {row.owner && <span>{row.owner}</span>}
              {row.wiresOut.length > 0 && <span>out → {row.wiresOut.join(', ')}</span>}
              {row.returnsTo.length > 0 && <span>returns ⇢ {row.returnsTo.join(', ')}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export const BreadboardPlaceNode = memo(BreadboardPlaceNodeComponent)
