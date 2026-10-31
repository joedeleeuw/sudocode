import { NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/core'
import { EntityBadge } from '@/components/entities'
import type { EntityType } from '@/types/api'

/**
 * EntityMentionComponent - React component for rendering entity mentions
 *
 * Displays entity mentions as interactive badges with:
 * - Icon indicating entity type (GitBranch for issues, FileText for specs)
 * - Color-coded badge (blue for issues, purple for specs)
 * - Link to entity page
 * - Optional display text instead of entity ID
 * - Optional relationship type badge
 * - Hover card with entity details (title, status, priority, executions/implementing issues)
 */
export function EntityMentionComponent({ node }: NodeViewProps) {
  const { entityId, entityType, displayText, relationshipType } = node.attrs as {
    entityId: string
    entityType: EntityType
    displayText?: string | null
    relationshipType?: string | null
  }

  return (
    <NodeViewWrapper as="span" className="inline-block" contentEditable={false}>
      <EntityBadge
        entityId={entityId}
        entityType={entityType}
        displayText={displayText}
        relationshipType={relationshipType}
      />
      {relationshipType && (
        <span className="ml-1 text-xs text-muted-foreground" contentEditable={false}>
          {relationshipType}
        </span>
      )}
    </NodeViewWrapper>
  )
}
