import { Position, type Edge, type Node } from '@xyflow/react'
import dagre from 'dagre'

export type FlowDimensions = { width: number; height: number }

export function layoutFlow(
  nodes: Node[],
  edges: Edge[],
  direction: 'TB' | 'LR',
  dimensions: (node: Node) => FlowDimensions,
  alignColumns: boolean
) {
  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: direction, nodesep: 50, ranksep: 80, marginx: 20, marginy: 20 })

  for (const node of nodes) graph.setNode(node.id, dimensions(node))
  for (const edge of edges) graph.setEdge(edge.source, edge.target)
  dagre.layout(graph)

  const horizontal = direction === 'LR'
  const columnTops = new Map<number, number>()
  if (horizontal && alignColumns) {
    for (const node of nodes) {
      const position = graph.node(node.id)
      const top = position.y - dimensions(node).height / 2
      columnTops.set(position.x, Math.min(columnTops.get(position.x) ?? Infinity, top))
    }
  }
  return {
    nodes: nodes.map((node) => {
      const size = dimensions(node)
      const position = graph.node(node.id)
      const columnTop = columnTops.get(position.x)
      if (horizontal && alignColumns && columnTop === undefined) {
        throw new Error(`Flow node ${node.id} has no column bounds.`)
      }
      return {
        ...node,
        targetPosition: horizontal ? Position.Left : Position.Top,
        sourcePosition: horizontal ? Position.Right : Position.Bottom,
        position: {
          x: position.x - size.width / 2,
          y: position.y - size.height / 2 - (columnTop === undefined ? 0 : columnTop - 20),
        },
      }
    }),
    edges,
  }
}
