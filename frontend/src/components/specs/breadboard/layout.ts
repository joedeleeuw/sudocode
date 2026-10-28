import type { Node } from '@xyflow/react'

export function breadboardDimensions(node: Node) {
  if (typeof node.data.layoutHeight !== 'number') {
    throw new Error(`Breadboard node ${node.id} has no layout height.`)
  }
  return { width: 380, height: node.data.layoutHeight }
}
