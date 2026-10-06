/**
 * 稳定内容哈希：忽略数组顺序与字段顺序差异，只比较业务内容。
 * 用于复核版本的冻结基线比对与多标签页冲突检测。
 */

function roundValue(value: number, digits: number) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

export function stableHash(value: unknown): string {
  const text = stableStringify(value)
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  // 附上长度，降低不同短文本碰撞概率
  return `h${(hash >>> 0).toString(36)}-${text.length.toString(36)}`
}

/** 关键点哈希：忽略 id（重新套模板/重新生成 id 不应判定为过期） */
export function hashPoints(points: Array<{ timeMin: number; tempC: number }>): string {
  return stableHash(
    points
      .map((point) => ({ timeMin: roundValue(point.timeMin, 2), tempC: roundValue(point.tempC, 1) }))
      .sort((a, b) => a.timeMin - b.timeMin || a.tempC - b.tempC),
  )
}

export function hashSamples(samples: Array<{ timeMin: number; tempC: number }>): string {
  return stableHash(
    samples
      .map((sample) => ({ timeMin: roundValue(sample.timeMin, 2), tempC: roundValue(sample.tempC, 1) }))
      .sort((a, b) => a.timeMin - b.timeMin),
  )
}
