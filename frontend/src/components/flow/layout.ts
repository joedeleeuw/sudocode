import { Position, type Edge, type Node } from '@xyflow/react'
import dagre from 'dagre'

export type FlowDimensions = { width: number; height: number }

export function layoutFlow(
  nodes: Node[],
  edges: Edge[],
  direction: 'TB' | 'LR',
  dimensions: (node: Node) => FlowDimensions
) {
  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: direction, nodesep: 50, ranksep: 80, marginx: 20, marginy: 20 })

  for (const node of nodes) graph.setNode(node.id, dimensions(node))
  for (const edge of edges) graph.setEdge(edge.source, edge.target)
  dagre.layout(graph)

  const horizontal = direction === 'LR'
  return {
    nodes: nodes.map((node) => {
      const size = dimensions(node)
      const position = graph.node(node.id)
      return {
        ...node,
        targetPosition: horizontal ? Position.Left : Position.Top,
        sourcePosition: horizontal ? Position.Right : Position.Bottom,
        position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
      }
    }),
    edges,
  }
}
