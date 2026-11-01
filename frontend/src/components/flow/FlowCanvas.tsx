import { useCallback, useMemo, type ReactNode } from 'react'
import {
  ReactFlow,
  Background,
  ControlButton,
  Controls,
  type Node,
  type Edge,
  type NodeMouseHandler,
  type NodeTypes,
  type EdgeTypes,
  type FitViewOptions,
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
  onFitView?: () => void
  defaultZoom?: number
  minimumZoom?: number
  minimumFitZoom?: number
  fitPadding?: FitViewOptions['padding']
  alignColumns?: boolean
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
  onFitView,
  defaultZoom,
  minimumZoom = 0.25,
  minimumFitZoom = 0.5,
  fitPadding,
  alignColumns = false,
  showControls = true,
  miniMap,
  children,
  className,
}: FlowCanvasProps) {
  const { actualTheme } = useTheme()
  const { nodes, edges } = useMemo(() => {
    const laidOut = layoutFlow(
      sourceNodes,
      layoutEdges ?? sourceEdges,
      direction,
      dimensions,
      alignColumns
    )
    return {
      nodes: laidOut.nodes,
      edges: routeEdges ? routeEdges(sourceEdges, laidOut.nodes) : laidOut.edges,
    }
  }, [sourceNodes, sourceEdges, layoutEdges, routeEdges, direction, dimensions, alignColumns])

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
        fitViewOptions={{ padding: fitPadding ?? 0.2, minZoom: minimumFitZoom, maxZoom: 1.5 }}
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
        {showControls && (
          <Controls
            showInteractive={false}
            position="top-right"
            showFitView={!onFitView}
            fitViewOptions={
              fitPadding === undefined
                ? undefined
                : { padding: fitPadding, minZoom: minimumFitZoom, maxZoom: 1.5 }
            }
          >
            {onFitView && (
              <ControlButton
                className="react-flow__controls-fitview"
                title="Fit View"
                aria-label="Fit View"
                onClick={onFitView}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 30" aria-hidden="true">
                  <path d="M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z" />
                </svg>
              </ControlButton>
            )}
          </Controls>
        )}
        {miniMap}
        {children}
      </ReactFlow>
    </div>
  )
}
