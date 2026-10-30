import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { PhrasingContent, Root, Table, TableCell } from 'mdast'

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

export type SpecBreadboardSlice = {
  id: string
  title: string
  affordanceIds: string[]
  issueId?: string
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

const sectionHeadings = [
  { heading: 'CURRENT breadboard', id: 'current' },
  { heading: 'TARGET breadboard', id: 'target' },
] as const

const tableKinds = [
  { heading: 'Places (P)', kind: 'places', columns: ['ID', 'Place', 'Description'] },
  {
    heading: 'UI / CLI Affordances (U)',
    kind: 'ui',
    columns: ['ID', 'Place', 'Affordance', 'Wires Out', 'Returns To'],
  },
  {
    heading: 'Code Affordances (N)',
    kind: 'code',
    columns: ['ID', 'Place', 'Component / Seam', 'Owner', 'Wires Out', 'Returns To'],
  },
  {
    heading: 'Data Stores (S)',
    kind: 'store',
    columns: ['ID', 'Place', 'Store / Boundary Schema', 'Owner'],
  },
] as const

const canonicalHeadings =
  'Use ## CURRENT breadboard or ## TARGET breadboard, with #### Places (P), #### UI / CLI Affordances (U), #### Code Affordances (N), and #### Data Stores (S).'

function sectionId(title: string) {
  return sectionHeadings.find((section) => section.heading === title)?.id ?? null
}

function affordanceKind(title: string) {
  return tableKinds.find((table) => table.heading === title)?.kind ?? null
}

function requireColumns(table: Table, columns: readonly string[], context: string) {
  const headings = table.children[0]?.children.map(cellText).map((heading) => heading.toLowerCase())
  for (const column of columns) {
    if (!headings?.includes(column.toLowerCase())) {
      throw new Error(
        `${context} is missing column ${column}. Required columns: ${columns.join(', ')}.`
      )
    }
  }
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
    const labelFields = {
      ui: 'affordance',
      code: 'component / seam',
      store: 'store / boundary schema',
    } satisfies Record<AffordanceKind, string>
    const labelField = labelFields[kind]
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

  const seenTables = new Map<SectionId, Set<string>>()
  for (const node of root.children) {
    if (node.type === 'heading') {
      const title = node.children.map(phrasingText).join('').trim()
      if (node.depth === 1) {
        activeSection = null
        activeTable = null
      } else if (node.depth === 2) {
        const id = sectionId(title)
        if (/breadboard/i.test(title) && !id)
          throw new Error(`Noncanonical heading ## ${title}. ${canonicalHeadings}`)
        if (id && seenTables.has(id))
          throw new Error(`Duplicate ${title} section. ${canonicalHeadings}`)
        if (id) seenTables.set(id, new Set())
        activeSection = id ? { id, places: [], affordances: [] } : null
        activeTable = null
        if (activeSection) sections.push(activeSection)
      } else if (node.depth === 4) {
        const kind = affordanceKind(title)
        if (kind && !activeSection)
          throw new Error(
            `Table heading #### ${title} is outside a canonical section. ${canonicalHeadings}`
          )
        activeTable = kind
      } else {
        activeTable = null
      }
      continue
    }
    if (node.type !== 'table' || !activeSection || !activeTable) continue
    const definition = tableKinds.find((table) => table.kind === activeTable)
    if (!definition)
      throw new Error(`Unknown breadboard table ${activeTable}. ${canonicalHeadings}`)
    const seen = seenTables.get(activeSection.id)
    if (seen?.has(activeTable))
      throw new Error(`Duplicate ${definition.heading} table in ${activeSection.id} breadboard.`)
    seen?.add(activeTable)
    requireColumns(node, definition.columns, `${activeSection.id} ${definition.heading}`)
    if (activeTable === 'places') {
      activeSection.places.push(...readPlaces(activeSection.id, node))
    } else {
      activeSection.affordances.push(...readAffordances(activeSection.id, activeTable, node))
    }
  }

  for (const section of sections) {
    for (const definition of tableKinds) {
      if (!seenTables.get(section.id)?.has(definition.kind)) {
        throw new Error(
          `${section.id} breadboard is missing #### ${definition.heading}. ${canonicalHeadings}`
        )
      }
    }
    validateSection(section)
  }
  return sections
}

function readSlices(root: Root, sections: SpecBreadboardSection[]): SpecBreadboardSlice[] {
  const slices: SpecBreadboardSlice[] = []
  const ids = new Set<string>()
  const affordanceIds = new Set(
    sections.flatMap((section) => section.affordances.map((row) => row.id))
  )
  let active = false

  for (const node of root.children) {
    if (node.type === 'heading' && node.depth <= 2) {
      active = node.depth === 2 && node.children.map(phrasingText).join('').trim() === 'Slices'
      continue
    }
    if (node.type !== 'table' || !active) continue
    requireColumns(node, ['ID', 'Title', 'Affordances', 'Issue'], '## Slices')
    for (const cells of tableRows(node)) {
      const row = rowRecord(cells)
      const id = requiredCell('target', row, 'id', 'slice')
      if (!/^V[1-9][0-9]*$/u.test(id))
        throw new Error(`Slice ID ${id} is invalid. Use V1, V2, … under ## Slices.`)
      if (ids.has(id)) throw new Error(`Duplicate slice ID ${id}.`)
      ids.add(id)
      const title = requiredCell('target', row, 'title', id)
      const issue = requiredCell('target', row, 'issue', id)
      const issueId = /^\[\[(i-[a-z0-9]+)\]\]$/u.exec(issue)?.[1]
      if (!issueId && issue !== '—')
        throw new Error(
          `Slice ${id} Issue token ${issue}: use [[i-xxxx]] or — for an unlinked slice.`
        )
      const referencedIds = requiredCell('target', row, 'affordances', id)
        .split(',')
        .map((part) => part.trim())

      for (const referencedId of referencedIds) {
        if (!/^[UNS][0-9]+$/u.test(referencedId) || !affordanceIds.has(referencedId)) {
          throw new Error(
            `Slice ${id} Affordances token "${referencedId}" is invalid. Use exact comma-separated IDs from the breadboard, such as U1, N1, S1; ranges and unknown IDs are not accepted.`
          )
        }
      }
      slices.push({
        id,
        title,
        affordanceIds: referencedIds,
        ...(issueId ? { issueId } : {}),
      })
    }
  }
  return slices
}

export function readSpecBreadboard(content: string) {
  const root = markdown.parse(content)
  const declared = root.children.some(
    (node) =>
      node.type === 'heading' &&
      ((node.depth === 2 && /breadboard/i.test(node.children.map(phrasingText).join(''))) ||
        (node.depth === 4 && affordanceKind(node.children.map(phrasingText).join(''))))
  )
  if (!declared) return { status: 'absent' as const }
  try {
    const sections = parseSections(root)
    return {
      status: 'available' as const,
      sections,
      slices: readSlices(root, sections),
    }
  } catch (cause) {
    return {
      status: 'invalid' as const,
      message: cause instanceof Error ? cause.message : 'Invalid breadboard tables.',
    }
  }
}
