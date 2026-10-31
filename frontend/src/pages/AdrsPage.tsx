import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import { useAdrs } from '@/hooks/useAdrs'
import { useProjectRoutes } from '@/hooks/useProjectRoutes'
import { SpecList } from '@/components/specs/SpecList'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'

export default function AdrsPage() {
  const { adrs, isLoading, createAdrAsync, isCreating } = useAdrs()
  const { paths } = useProjectRoutes()
  const navigate = useNavigate()
  const [filterText, setFilterText] = useState('')
  const [showEditor, setShowEditor] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [error, setError] = useState<string | null>(null)

  const filteredAdrs = useMemo(() => {
    const query = filterText.toLowerCase()
    return adrs
      .filter((adr) =>
        !query ||
        adr.id.toLowerCase().includes(query) ||
        adr.title.toLowerCase().includes(query) ||
        adr.content.toLowerCase().includes(query)
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
  }, [adrs, filterText])

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!title.trim()) {
      setError('Title is required')
      return
    }
    try {
      const adr = await createAdrAsync({ title: title.trim(), content: content.trim() })
      setTitle('')
      setContent('')
      setShowEditor(false)
      navigate(paths.adr(adr.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to create ADR')
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center justify-between border-b bg-background p-4">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold">Architecture Decisions</h1>
          <Badge variant="secondary">{adrs.length}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              placeholder="Filter ADRs..."
              className="h-9 w-64 pl-8"
            />
          </div>
          <Button onClick={() => setShowEditor(!showEditor)} size="sm">
            <Plus className="mr-2 h-4 w-4" />
            Create ADR
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-auto px-8 py-4">
        {showEditor && (
          <Card className="mb-6 p-6">
            <form onSubmit={handleCreate} className="space-y-4">
              <h2 className="text-xl font-semibold">New Architecture Decision</h2>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Decision title"
                autoFocus
              />
              <Textarea
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder="Context, decision, and why. Optionally add Considered Options and Consequences."
                className="min-h-40"
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setShowEditor(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isCreating}>Create</Button>
              </div>
            </form>
          </Card>
        )}
        <SpecList specs={filteredAdrs} loading={isLoading} emptyMessage="No ADRs found" entityType="adr" />
      </div>
    </div>
  )
}
