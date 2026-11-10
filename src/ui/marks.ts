/** Hallmark-style punches, one per holding. Drawn inline so they scale and need no requests. */
export type MarkId = 'gold' | 'euro' | 'bitcoin' | 'usdt' | 'nim' | 'staked' | 'coffer'

const INK = '#1b1608'

function punch(shape: string, fill: string, glyph: string, size = 17): string {
  return `<svg class="mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">${shape.replace('FILL', fill)}<text x="24" y="${24 + size * 0.36}" text-anchor="middle" font-family="Georgia, serif" font-size="${size}" font-weight="700" fill="${INK}">${glyph}</text></svg>`
}

const SHAPES = {
  oval: '<ellipse cx="24" cy="24" rx="22" ry="15" fill="FILL"/>',
  shield: '<path d="M6 8h36v18c0 9-8 14-18 18C14 40 6 35 6 26z" fill="FILL"/>',
  square: '<rect x="6" y="6" width="36" height="36" rx="3" fill="FILL"/>',
  circle: '<circle cx="24" cy="24" r="19" fill="FILL"/>',
  hexagon: '<path d="M14 6h20l11 18-11 18H14L3 24z" fill="FILL"/>',
  octagon: '<path d="M15 4h18l11 11v18L33 44H15L4 33V15z" fill="FILL"/>',
}

export function mark(id: MarkId): string {
  switch (id) {
    case 'gold':
      return punch(SHAPES.oval, '#e3bd62', 'Au', 16)
    case 'euro':
      return punch(SHAPES.shield, '#a9c6f5', '€', 20)
    case 'bitcoin':
      return punch(SHAPES.square, '#f2a65a', '₿', 20)
    case 'usdt':
      return punch(SHAPES.circle, '#9be0b4', '$', 20)
    case 'nim':
      return punch(SHAPES.hexagon, '#f6d58a', 'N', 18)
    case 'staked':
      return punch(SHAPES.hexagon, '#c9b3f5', 'N+', 15)
    case 'coffer':
      return punch(SHAPES.octagon, '#e3bd62', 'C', 22)
  }
}

export const MARK_COLOR: Record<Exclude<MarkId, 'coffer'>, string> = {
  gold: '#e3bd62',
  euro: '#a9c6f5',
  bitcoin: '#f2a65a',
  usdt: '#9be0b4',
  nim: '#f6d58a',
  staked: '#c9b3f5',
}
