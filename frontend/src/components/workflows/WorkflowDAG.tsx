import { useMemo } from 'react'
import { MiniMap, type Node, type Edge, MarkerType } from '@xyflow/react'
import type { WorkflowStep } from '@/types/workflow'
import type { Issue } from '@/types/api'
import { WorkflowStepNode, type WorkflowStepNodeData } from './WorkflowStepNode'
import { useTheme } from '@/contexts/ThemeContext'
import { FlowCanvas } from '@/components/flow/FlowCanvas'

const workflowDimensions = () => ({ width: 280, height: 80 })

// =============================================================================
// Types
// =============================================================================

export interface WorkflowDAGProps {
  /** Workflow steps to visualize */
  steps: WorkflowStep[]
  /** Optional issue data for enriching step display */
  issues?: Record<string, Issue>
  /** Currently selected step ID */
  selectedStepId?: string
  /** Callback when a step is selected */
  onStepSelect?: (stepId: string) => void
  /** Callback when clicking on empty pane area (useful for deselecting) */
  onPaneClick?: () => void
  /** Callback for step actions (retry, skip, cancel) */
  onStepAction?: (stepId: string, action: 'retry' | 'skip' | 'cancel') => void
  sliceIdByIssueId?: Record<string, string>
  onOpenSlice?: (sliceId: string) => void
  /** Whether the DAG is interactive (default: true) */
  interactive?: boolean
  /** Show minimap (default: true) */
  showMinimap?: boolean
  /** Show controls (default: true) */
  showControls?: boolean
  /** Custom class name */
  className?: string
}

/**
 * Convert WorkflowStep[] to React Flow nodes and edges
 */
function stepsToFlowElements(
  steps: WorkflowStep[],
  issues?: Record<string, Issue>,
  selectedStepId?: string,
  onStepSelect?: (stepId: string) => void,
  sliceIdByIssueId?: Record<string, string>,
  onOpenSlice?: (sliceId: string) => void
): { nodes: Node<WorkflowStepNodeData>[]; edges: Edge[] } {
  // Create nodes from steps
  const nodes: Node<WorkflowStepNodeData>[] = steps.map((step) => ({
    id: step.id,
    type: 'workflowStep',
    position: { x: 0, y: 0 }, // Will be calculated by dagre
    data: {
      step,
      issue: issues?.[step.issueId],
      isSelected: step.id === selectedStepId,
      sliceId: sliceIdByIssueId?.[step.issueId],
      onSelect: onStepSelect,
      onOpenSlice,
    },
  }))

  // Create edges from dependencies
  const edges: Edge[] = []
  steps.forEach((step) => {
    step.dependencies.forEach((depId) => {
      // Find if dependency exists in steps
      const depExists = steps.some((s) => s.id === depId)
      if (depExists) {
        const isTargetRunning = step.status === 'running'
        const isSourceCompleted = steps.find((s) => s.id === depId)?.status === 'completed'

        edges.push({
          id: `${depId}-${step.id}`,
          source: depId,
          target: step.id,
          type: 'smoothstep',
          animated: isTargetRunning,
          style: {
            stroke: isSourceCompleted ? '#22c55e' : '#94a3b8',
            strokeWidth: 2,
            opacity: isSourceCompleted ? 0.6 : 1,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: isSourceCompleted ? '#22c55e' : '#94a3b8',
          },
        })
      }
    })
  })

  return { nodes, edges }
}

// =============================================================================
// Custom Node Types
// =============================================================================

const nodeTypes = {
  workflowStep: WorkflowStepNode,
}

// =============================================================================
// Component
// =============================================================================

export function WorkflowDAG({
  steps,
  issues,
  selectedStepId,
  onStepSelect,
  onPaneClick,
  sliceIdByIssueId,
  onOpenSlice,
  interactive = true,
  showMinimap = true,
  showControls = true,
  className,
}: WorkflowDAGProps) {
  // Get current theme for dark mode support
  const { actualTheme } = useTheme()
  const isDark = actualTheme === 'dark'

  const { nodes, edges } = useMemo(
    () =>
      stepsToFlowElements(
        steps,
        issues,
        selectedStepId,
        onStepSelect,
        sliceIdByIssueId,
        onOpenSlice
      ),
    [steps, issues, selectedStepId, onStepSelect, sliceIdByIssueId, onOpenSlice]
  )

  // Empty state
  if (steps.length === 0) {
    return (
      <div className={`flex h-full items-center justify-center text-muted-foreground ${className}`}>
        <p>No steps in workflow</p>
      </div>
    )
  }

  return (
    <FlowCanvas
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      dimensions={workflowDimensions}
      onNodeSelect={onStepSelect}
      onPaneClick={onPaneClick}
      interactive={interactive}
      showControls={showControls}
      className={className}
      miniMap={
        showMinimap ? (
          <MiniMap<Node<WorkflowStepNodeData>>
            nodeColor={(node) => {
              const step = node.data.step
              switch (step.status) {
                case 'completed':
                  return '#22c55e'
                case 'running':
                  return '#3b82f6'
                case 'failed':
                  return '#ef4444'
                case 'blocked':
                  return '#eab308'
                case 'skipped':
                  return '#9ca3af'
                case 'ready':
                  return '#3b82f6'
                default:
                  return '#94a3b8'
              }
            }}
            maskColor={isDark ? 'rgba(0, 0, 0, 0.6)' : 'rgba(0, 0, 0, 0.1)'}
            className="rounded-lg border bg-background"
          />
        ) : undefined
      }
    />
  )
}

export default WorkflowDAG
