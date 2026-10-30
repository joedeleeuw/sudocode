import { useCallback, useMemo, type ReactNode } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeMouseHandler,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useTheme } from '@/contexts/ThemeContext'
import { layoutFlow, type FlowDimensions } from './layout'

type FlowCanvasProps = {
  nodes: Node[]
  edges: Edge[]
  layoutEdges?: Edge[]
  routeEdges?: (edges: Edge[], nodes: Node[]) => Edge[]
  nodeTypes: NodeTypes
  edgeTypes?: EdgeTypes
  dimensions: (node: Node) => FlowDimensions
  direction?: 'TB' | 'LR'
  onNodeSelect?: (nodeId: string) => void
  onPaneClick?: () => void
  interactive?: boolean
  fitView?: boolean
  defaultZoom?: number
  minimumZoom?: number
  minimumFitZoom?: number
  showControls?: boolean
  miniMap?: ReactNode
  children?: ReactNode
  className?: string
}

export function FlowCanvas({
  nodes: sourceNodes,
  edges: sourceEdges,
  layoutEdges,
  routeEdges,
  nodeTypes,
  edgeTypes,
  dimensions,
  direction = 'TB',
  onNodeSelect,
  onPaneClick,
  interactive = true,
  fitView = true,
  defaultZoom,
  minimumZoom = 0.25,
  minimumFitZoom = 0.5,
  showControls = true,
  miniMap,
  children,
  className,
}: FlowCanvasProps) {
  const { actualTheme } = useTheme()
  const { nodes, edges } = useMemo(() => {
    const laidOut = layoutFlow(sourceNodes, layoutEdges ?? sourceEdges, direction, dimensions)
    return {
      nodes: laidOut.nodes,
      edges: routeEdges ? routeEdges(sourceEdges, laidOut.nodes) : laidOut.edges,
    }
  }, [sourceNodes, sourceEdges, layoutEdges, routeEdges, direction, dimensions])

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      if (interactive) onNodeSelect?.(node.id)
    },
    [interactive, onNodeSelect]
  )

  return (
    <div className={`h-full w-full ${className ?? ''}`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeClick={handleNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={actualTheme}
        fitView={fitView}
        defaultViewport={defaultZoom === undefined ? undefined : { x: 0, y: 0, zoom: defaultZoom }}
        fitViewOptions={{ padding: 0.2, minZoom: minimumFitZoom, maxZoom: 1.5 }}
        minZoom={minimumZoom}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={interactive}
        zoomOnScroll={interactive}
        zoomOnPinch={interactive}
        zoomOnDoubleClick={interactive}
        preventScrolling={interactive}
        proOptions={{ hideAttribution: true }}
      >
        <Background color={actualTheme === 'dark' ? '#334155' : '#e2e8f0'} gap={16} size={1} />
        {showControls && <Controls showInteractive={false} position="top-right" />}
        {miniMap}
        {children}
      </ReactFlow>
    </div>
  )
}
