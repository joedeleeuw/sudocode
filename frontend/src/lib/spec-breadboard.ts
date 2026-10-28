import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { PhrasingContent, Root, RootContent, Table, TableCell } from 'mdast'

type SectionId = 'current' | 'target'
type AffordanceKind = 'ui' | 'code' | 'store'

type BreadboardPlace = {
  id: string
  name: string
  description: string
}

type BreadboardAffordance = {
  id: string
  kind: AffordanceKind
  placeIds: string[]
  label: string
  owner?: string
  wiresOut: string[]
  returnsTo: string[]
}

export type SpecBreadboardSection = {
  id: SectionId
  places: BreadboardPlace[]
  affordances: BreadboardAffordance[]
}

export type SpecBreadboardProjection = ReturnType<typeof readSpecBreadboard>

const markdown = unified().use(remarkParse).use(remarkGfm)

function phrasingText(node: PhrasingContent): string {
  if ('value' in node) return node.value
  if ('children' in node) return node.children.map(phrasingText).join('')
  return ''
}

function cellText(cell: TableCell): string {
  return cell.children.map(phrasingText).join('').trim()
}

type TableRow = { heading: string; cell: string }[]

function tableRows(table: Table): TableRow[] {
  const [header, ...rows] = table.children
  if (!header) throw new Error('Breadboard table has no header row.')
  const headings = header.children.map(cellText)
  return rows.map((row) =>
    headings.map((heading, index) => ({
      heading,
      cell: cellText(row.children[index] ?? { children: [] }),
    }))
  )
}

function rowRecord(row: TableRow) {
  return Object.fromEntries(row.map(({ heading, cell }) => [heading.toLowerCase(), cell]))
}

function requiredCell(
  section: SectionId,
  row: Record<string, string>,
  field: string,
  id: string
): string {
  const value = row[field]?.trim()
  if (!value) throw new Error(`${section} breadboard row ${id} is missing ${field}.`)
  return value
}

function placeIds(section: SectionId, value: string, id: string): string[] {
  const ids = value
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  if (ids.length === 0) throw new Error(`${section} breadboard row ${id} has no place.`)
  return ids
}

function wireTargets(value: string | undefined): string[] {
  if (!value || value === '—' || value === '-') return []
  return value
    .split(',')
    .map((target) => target.trim().replace(/^->\s*/, ''))
    .filter(Boolean)
}

function sectionId(title: string): SectionId | null {
  const normalized = title.trim().toLowerCase()
  if (normalized === 'current breadboard') return 'current'
  if (normalized === 'target breadboard') return 'target'
  return null
}

function affordanceKind(title: string): AffordanceKind | 'places' | null {
  const normalized = title.trim().toLowerCase()
  if (normalized === 'places (p)') return 'places'
  if (normalized === 'ui / cli affordances (u)') return 'ui'
  if (normalized === 'code affordances (n)') return 'code'
  if (normalized === 'data stores (s)') return 'store'
  return null
}

function readPlaces(section: SectionId, table: Table): BreadboardPlace[] {
  return tableRows(table).map((cells) => {
    const row = rowRecord(cells)
    const id = requiredCell(section, row, 'id', 'place')
    return {
      id,
      name: requiredCell(section, row, 'place', id),
      description: requiredCell(section, row, 'description', id),
    }
  })
}

function readAffordances(
  section: SectionId,
  kind: AffordanceKind,
  table: Table
): BreadboardAffordance[] {
  return tableRows(table).map((cells) => {
    const row = rowRecord(cells)
    const id = requiredCell(section, row, 'id', kind)
    const labelField =
      kind === 'ui'
        ? 'affordance'
        : kind === 'code'
          ? 'component / seam'
          : 'store / boundary schema'
    const label = requiredCell(section, row, labelField, id)
    return {
      id,
      kind,
      placeIds: placeIds(section, requiredCell(section, row, 'place', id), id),
      label,
      ...(kind === 'ui' ? {} : { owner: requiredCell(section, row, 'owner', id) }),
      wiresOut: wireTargets(row['wires out']),
      returnsTo: wireTargets(row['returns to']),
    }
  })
}

function validateSection(section: SpecBreadboardSection) {
  const placeIds = new Set(section.places.map((place) => place.id))
  const affordanceIds = new Set<string>()
  const targetIds = new Set([...placeIds, ...section.affordances.map((row) => row.id)])
  if (placeIds.size !== section.places.length) {
    throw new Error(`${section.id} breadboard has duplicate place IDs.`)
  }
  if (section.places.length === 0 || section.affordances.length === 0) {
    throw new Error(`${section.id} breadboard needs places and affordances.`)
  }
  for (const row of section.affordances) {
    if (affordanceIds.has(row.id)) {
      throw new Error(`${section.id} breadboard has duplicate affordance ID ${row.id}.`)
    }
    affordanceIds.add(row.id)
    for (const placeId of row.placeIds) {
      if (!placeIds.has(placeId)) {
        throw new Error(
          `${section.id} breadboard row ${row.id} references unknown place ${placeId}.`
        )
      }
    }
    if (row.kind === 'store' && row.wiresOut.length > 0) {
      throw new Error(`${section.id} breadboard store ${row.id} must not wire out.`)
    }
    for (const target of [...row.wiresOut, ...row.returnsTo]) {
      if (!targetIds.has(target)) {
        throw new Error(
          `${section.id} breadboard row ${row.id} references unknown target ${target}.`
        )
      }
    }
  }
}

function parseSections(root: Root): SpecBreadboardSection[] {
  const sections: SpecBreadboardSection[] = []
  let activeSection: SpecBreadboardSection | null = null
  let activeTable: AffordanceKind | 'places' | null = null

  for (const node of root.children as RootContent[]) {
    if (node.type === 'heading') {
      const title = node.children.map(phrasingText).join('').trim()
      if (node.depth === 2) {
        const id = sectionId(title)
        activeSection = id ? { id, places: [], affordances: [] } : null
        activeTable = null
        if (activeSection) sections.push(activeSection)
      } else if (node.depth === 4) {
        activeTable = activeSection ? affordanceKind(title) : null
      } else {
        activeTable = null
      }
      continue
    }
    if (node.type !== 'table' || !activeSection || !activeTable) continue
    if (activeTable === 'places') {
      activeSection.places.push(...readPlaces(activeSection.id, node))
    } else {
      activeSection.affordances.push(...readAffordances(activeSection.id, activeTable, node))
    }
  }

  for (const section of sections) validateSection(section)
  return sections
}

export function readSpecBreadboard(content: string) {
  const root = markdown.parse(content)
  const declared = root.children.some(
    (node) =>
      node.type === 'heading' &&
      node.depth === 2 &&
      sectionId(node.children.map(phrasingText).join(''))
  )
  if (!declared) return { status: 'absent' as const }
  try {
    return { status: 'available' as const, sections: parseSections(root) }
  } catch (cause) {
    return {
      status: 'invalid' as const,
      message: cause instanceof Error ? cause.message : 'Invalid breadboard tables.',
    }
  }
}
