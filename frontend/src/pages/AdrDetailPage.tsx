import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Archive, ArchiveRestore, ArrowLeft, MessageSquarePlus } from 'lucide-react'
import { useAdr, useAdrs } from '@/hooks/useAdrs'
import { useSpecFeedback } from '@/hooks/useSpecs'
import { useSpecRelationships } from '@/hooks/useSpecRelationships'
import { useIssues } from '@/hooks/useIssues'
import { useFeedback } from '@/hooks/useFeedback'
import { useFeedbackPositions } from '@/hooks/useFeedbackPositions'
import { useProjectRoutes } from '@/hooks/useProjectRoutes'
import { SpecViewerTiptap } from '@/components/specs/SpecViewerTiptap'
import { AlignedFeedbackPanel } from '@/components/specs/AlignedFeedbackPanel'
import { AddFeedbackDialog } from '@/components/specs/AddFeedbackDialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { relationshipsApi } from '@/lib/api'
import type {
  EntityType,
  FeedbackAnchor,
  FeedbackType,
  IssueFeedback,
  Relationship,
  RelationshipType,
} from '@/types/api'

export default function AdrDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { paths } = useProjectRoutes()
  const { adr, isLoading, isError } = useAdr(id)
  const { updateAdrAsync, archiveAdr, unarchiveAdr, isUpdating } = useAdrs()
  const { feedback } = useSpecFeedback(id)
  const { issues } = useIssues()
  const { createFeedback, updateFeedback, deleteFeedback } = useFeedback(id)
  const { relationships } = useSpecRelationships(id, 'adr')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [viewMode, setViewMode] = useState<'formatted' | 'source'>('formatted')
  const [selectedLine, setSelectedLine] = useState<number | null>(null)
  const [showFeedbackPanel, setShowFeedbackPanel] = useState(true)
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const feedbackPositions = useFeedbackPositions(feedback, editorContainerRef)

  useEffect(() => {
    if (adr) {
      setTitle(adr.title)
      setContent(adr.content)
    }
  }, [adr])

  if (isLoading) {
    return <div className="p-12 text-center text-muted-foreground">Loading ADR...</div>
  }
  if (isError || !adr) {
    return (
      <div className="p-12 text-center">
        <h2 className="mb-4 text-2xl font-bold">ADR not found</h2>
        <Button onClick={() => navigate(paths.adrs())}>Back to ADRs</Button>
      </div>
    )
  }

  const state = adr.archived ? 'archived' : adr.superseded ? 'superseded' : 'accepted'
  const handleSave = async () => {
    await updateAdrAsync({ id, data: { title, content } })
  }
  const handleFeedbackClick = (entry: IssueFeedback) => {
    if (!entry.anchor) return
    try {
      const anchor: unknown = JSON.parse(entry.anchor)
      if (typeof anchor === 'object' && anchor !== null && 'line_number' in anchor) {
        if (typeof anchor.line_number === 'number') setSelectedLine(anchor.line_number)
      }
    } catch (error) {
      console.error('Failed to parse feedback anchor:', error)
    }
  }
  const handleCreateFeedback = async (data: {
    issueId?: string
    type: FeedbackType
    content: string
    anchor?: FeedbackAnchor
  }) => {
    await createFeedback({
      to_id: id,
      issue_id: data.issueId,
      feedback_type: data.type,
      content: data.content,
      anchor: data.anchor,
    })
  }
  const handleDeleteRelationship = async (relationship: Relationship) => {
    await relationshipsApi.delete({
      from_id: relationship.from_id,
      from_type: relationship.from_type,
      to_id: relationship.to_id,
      to_type: relationship.to_type,
      relationship_type: relationship.relationship_type,
    })
  }
  const handleCreateRelationship = async (
    toId: string,
    toType: EntityType,
    relationshipType: RelationshipType
  ) => {
    await relationshipsApi.create({
      from_id: id,
      from_type: 'adr',
      to_id: toId,
      to_type: toType,
      relationship_type: relationshipType,
    })
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center justify-between border-b bg-background p-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate(paths.adrs())}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Badge variant="adr" className="font-mono">{adr.id}</Badge>
          <Badge variant={state === 'accepted' ? 'secondary' : 'outline'}>{state}</Badge>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-lg font-semibold outline-none"
            aria-label="ADR title"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowFeedbackPanel(!showFeedbackPanel)}>
            Feedback ({feedback.length})
          </Button>
          <Button variant="outline" size="sm" onClick={handleSave} disabled={isUpdating}>
            Save
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => adr.archived ? unarchiveAdr(id) : archiveAdr(id)}
            disabled={isUpdating}
          >
            {adr.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div ref={editorContainerRef} className="relative mx-auto max-w-6xl px-6 py-6">
          <div className="mb-3 flex justify-end">
            <div className="flex rounded border p-0.5">
              <Button
                variant={viewMode === 'formatted' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('formatted')}
              >
                Formatted
              </Button>
              <Button
                variant={viewMode === 'source' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('source')}
              >
                Markdown
              </Button>
            </div>
          </div>
          <SpecViewerTiptap
            content={content}
            feedback={feedback}
            selectedLine={selectedLine}
            onLineClick={setSelectedLine}
            onTextSelect={(_text, lineNumber) => setSelectedLine(lineNumber)}
            onFeedbackClick={handleFeedbackClick}
            onChange={setContent}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
          />
          {showFeedbackPanel && (
            <div className="pointer-events-none absolute right-0 top-0">
              <div className="pointer-events-auto sticky top-0">
                <AlignedFeedbackPanel
                  feedback={feedback}
                  positions={feedbackPositions}
                  relationships={relationships}
                  currentEntityId={id}
                  onFeedbackClick={handleFeedbackClick}
                  onDismiss={(feedbackId) => {
                    const entry = feedback.find((candidate) => candidate.id === feedbackId)
                    if (entry) {
                      updateFeedback({ id: feedbackId, data: { dismissed: !entry.dismissed } })
                    }
                  }}
                  onDelete={deleteFeedback}
                  onDeleteRelationship={handleDeleteRelationship}
                  onCreateRelationship={handleCreateRelationship}
                  addFeedbackButton={
                    <AddFeedbackDialog
                      issues={issues}
                      lineNumber={selectedLine ?? undefined}
                      onSubmit={handleCreateFeedback}
                      triggerButton={
                        <Button variant="secondary" size="sm">
                          <MessageSquarePlus className="mr-2 h-4 w-4" />
                          Add Feedback
                        </Button>
                      }
                    />
                  }
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
