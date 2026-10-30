import { BaseEdge, Position, useStore, type Edge, type EdgeProps } from '@xyflow/react'
import { shallow } from 'zustand/shallow'

type Point = { x: number; y: number }
type Rectangle = { left: number; right: number; top: number; bottom: number }
type Step = {
  x: number
  y: number
  direction: 'horizontal' | 'vertical' | 'start'
  cost: number
  previous?: string
}

export type BreadboardWire = Edge<{ kind: 'out' | 'return' }, 'breadboard'>

const WIRE_ROUTES = {
  out: { clearance: 12, escapeDistance: 20 },
  return: { clearance: 18, escapeDistance: 26 },
} satisfies Record<
  NonNullable<BreadboardWire['data']>['kind'],
  { clearance: number; escapeDistance: number }
>

function segmentClear(from: Point, to: Point, rectangles: Rectangle[]) {
  return rectangles.every((rectangle) => {
    if (from.x === to.x) {
      return (
        from.x <= rectangle.left ||
        from.x >= rectangle.right ||
        Math.max(from.y, to.y) <= rectangle.top ||
        Math.min(from.y, to.y) >= rectangle.bottom
      )
    }
    return (
      from.y <= rectangle.top ||
      from.y >= rectangle.bottom ||
      Math.max(from.x, to.x) <= rectangle.left ||
      Math.min(from.x, to.x) >= rectangle.right
    )
  })
}

function route(start: Point, end: Point, rectangles: Rectangle[]) {
  const xs = [...new Set([start.x, end.x, ...rectangles.flatMap((r) => [r.left, r.right])])].sort(
    (a, b) => a - b
  )
  const ys = [...new Set([start.y, end.y, ...rectangles.flatMap((r) => [r.top, r.bottom])])].sort(
    (a, b) => a - b
  )
  const key = (step: Pick<Step, 'x' | 'y' | 'direction'>) => `${step.x},${step.y},${step.direction}`
  const initial: Step = { ...start, direction: 'start', cost: 0 }
  const steps = new Map([[key(initial), initial]])
  const pending = [initial]
  let finish: Step | undefined
  while (pending.length) {
    pending.sort((a, b) => a.cost - b.cost)
    const current = pending.shift()
    if (!current) break
    if (current.cost !== steps.get(key(current))?.cost) continue
    if (current.x === end.x && current.y === end.y) {
      finish = current
      break
    }
    const xi = xs.indexOf(current.x)
    const yi = ys.indexOf(current.y)
    const neighbours = [
      { x: xs[xi - 1], y: current.y, direction: 'horizontal' },
      { x: xs[xi + 1], y: current.y, direction: 'horizontal' },
      { x: current.x, y: ys[yi - 1], direction: 'vertical' },
      { x: current.x, y: ys[yi + 1], direction: 'vertical' },
    ] as const
    for (const next of neighbours) {
      if (next.x === undefined || next.y === undefined || !segmentClear(current, next, rectangles))
        continue
      const cost =
        current.cost +
        Math.abs(next.x - current.x) +
        Math.abs(next.y - current.y) +
        (current.direction !== 'start' && current.direction !== next.direction ? 16 : 0)
      const candidate: Step = { ...next, cost, previous: key(current) }
      const candidateKey = key(candidate)
      if (cost >= (steps.get(candidateKey)?.cost ?? Infinity)) continue
      steps.set(candidateKey, candidate)
      pending.push(candidate)
    }
  }
  if (!finish) throw new Error('Breadboard wire cannot be routed around measured places.')
  const points: Point[] = []
  let current: Step | undefined = finish
  while (current) {
    points.push({ x: current.x, y: current.y })
    current = current.previous ? steps.get(current.previous) : undefined
  }
  return points.reverse()
}

export function BreadboardEdge({
  id,
  data,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  style,
  markerEnd,
}: EdgeProps<BreadboardWire>) {
  if (!data) throw new Error(`Breadboard wire ${id} has no kind.`)
  const { clearance, escapeDistance } = WIRE_ROUTES[data.kind]
  const nodes = useStore((state) => [...state.nodeLookup.values()], shallow)
  if (
    nodes.some((node) => node.measured?.width === undefined || node.measured.height === undefined)
  )
    return null
  const rectangles = nodes.map((node) => {
    const width = node.measured?.width
    const height = node.measured?.height
    if (width === undefined || height === undefined)
      throw new Error(`Breadboard place ${node.id} has no measured bounds.`)
    return {
      left: node.internals.positionAbsolute.x - clearance,
      right: node.internals.positionAbsolute.x + width + clearance,
      top: node.internals.positionAbsolute.y - clearance,
      bottom: node.internals.positionAbsolute.y + height + clearance,
    }
  })
  const start = { x: sourceX, y: sourceY }
  const end = { x: targetX, y: targetY }
  const escapedStart = {
    x: sourceX + (sourcePosition === Position.Left ? -escapeDistance : escapeDistance),
    y: sourceY,
  }
  const escapedEnd = {
    x: targetX + (targetPosition === Position.Left ? -escapeDistance : escapeDistance),
    y: targetY,
  }
  let points: Point[]
  if (escapedStart.x === escapedEnd.x && escapedStart.y === escapedEnd.y) {
    const outer = {
      x: escapedStart.x + (sourcePosition === Position.Left ? -escapeDistance : escapeDistance),
      y: escapedStart.y,
    }
    const turn = { x: outer.x, y: outer.y - escapeDistance }
    points = [start, escapedStart, ...route(escapedStart, turn, rectangles), outer, escapedEnd, end]
  } else {
    points = [start, ...route(escapedStart, escapedEnd, rectangles), end]
  }
  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ')
  return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
}
