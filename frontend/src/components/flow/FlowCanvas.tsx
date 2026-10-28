import { useCallback, useEffect, useMemo, type ReactNode } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeMouseHandler,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useTheme } from '@/contexts/ThemeContext'
import { layoutFlow, type FlowDimensions } from './layout'

type FlowCanvasProps = {
  nodes: Node[]
  edges: Edge[]
  nodeTypes: NodeTypes
  dimensions: (node: Node) => FlowDimensions
  direction?: 'TB' | 'LR'
  onNodeSelect?: (nodeId: string) => void
  onPaneClick?: () => void
  interactive?: boolean
  fitView?: boolean
  defaultZoom?: number
  showControls?: boolean
  miniMap?: ReactNode
  className?: string
}

export function FlowCanvas({
  nodes: sourceNodes,
  edges: sourceEdges,
  nodeTypes,
  dimensions,
  direction = 'TB',
  onNodeSelect,
  onPaneClick,
  interactive = true,
  fitView = true,
  defaultZoom,
  showControls = true,
  miniMap,
  className,
}: FlowCanvasProps) {
  const { actualTheme } = useTheme()
  const initial = useMemo(
    () => layoutFlow(sourceNodes, sourceEdges, direction, dimensions),
    [sourceNodes, sourceEdges, direction, dimensions]
  )
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges)

  useEffect(() => {
    const laidOut = layoutFlow(sourceNodes, sourceEdges, direction, dimensions)
    setNodes(laidOut.nodes)
    setEdges(laidOut.edges)
  }, [sourceNodes, sourceEdges, direction, dimensions, setNodes, setEdges])

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
        onNodesChange={interactive ? onNodesChange : undefined}
        onEdgesChange={interactive ? onEdgesChange : undefined}
        onNodeClick={handleNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        colorMode={actualTheme}
        fitView={fitView}
        defaultViewport={defaultZoom === undefined ? undefined : { x: 0, y: 0, zoom: defaultZoom }}
        fitViewOptions={{ padding: 0.2, minZoom: 0.5, maxZoom: 1.5 }}
        minZoom={0.25}
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
        {showControls && <Controls showInteractive={false} />}
        {miniMap}
      </ReactFlow>
    </div>
  )
}
