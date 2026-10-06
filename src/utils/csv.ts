import type { CsvParseResult, FiringSample } from '../types/firing'

/**
 * 解析记录仪 CSV。
 * - 表头支持 time/temp、时间/温度等命名，缺表头时按列位置 0/1
 * - 时间支持分钟数或 hh:mm:ss
 * - 坏行（缺字段、非数值、温度越界等）进入 badRows 隔离，不影响好记录
 */
export function parseTemperatureCsv(content: string): CsvParseResult {
  const badRows: string[] = []
  const text = content.replace(/^﻿/, '').trim()
  if (!text) {
    return { samples: [], badRows: [], reason: '文件为空。' }
  }
  const rawLines = text.split(/\r?\n/)
  const lines = rawLines.map((line) => line.trim()).filter(Boolean)
  if (lines.length < 2) {
    return { samples: [], badRows: [], reason: '至少需要表头和一行记录。' }
  }

  const headers = splitCsvLine(lines[0]).map((value) => value.trim().toLowerCase())
  const namedTime = headers.findIndex((header) =>
    ['time', 'minute', 'minutes', '时间', '分钟', '经过时间'].includes(header),
  )
  const namedTemp = headers.findIndex((header) =>
    ['temp', 'temperature', 'temperature_c', '温度', '温度c', '实测温度'].includes(header),
  )
  const hasHeader = namedTime >= 0 || namedTemp >= 0
  const timeIndex = hasHeader ? (namedTime >= 0 ? namedTime : 0) : 0
  const tempIndex = hasHeader ? (namedTemp >= 0 ? namedTemp : 1) : 1

  const dataLines = hasHeader ? lines.slice(1) : lines
  const stamp = Date.now()
  const samples: FiringSample[] = []

  dataLines.forEach((line) => {
    const values = splitCsvLine(line)
    const rawTime = values[timeIndex]?.trim() ?? ''
    const rawTemp = values[tempIndex]?.trim() ?? ''
    const numericTime = Number(rawTime)
    const numericTemp = Number(rawTemp)

    if (!rawTime || !rawTemp || rawTime === 'NaN' || rawTemp === 'NaN') {
      badRows.push(line)
      return
    }
    if (Number.isNaN(numericTime) && !rawTime.includes(':')) {
      badRows.push(line)
      return
    }
    if (Number.isNaN(numericTemp)) {
      badRows.push(line)
      return
    }

    let timeMin: number
    if (rawTime.includes(':')) {
      const parts = rawTime.split(':')
      if (parts.some((part) => Number.isNaN(Number(part)))) {
        badRows.push(line)
        return
      }
      const totalSeconds = parts.reduce((total, value) => total * 60 + Number(value), 0)
      timeMin = parts.length === 3 ? totalSeconds / 60 : totalSeconds
    } else {
      timeMin = numericTime
    }

    if (!Number.isFinite(timeMin) || timeMin < 0 || !Number.isFinite(numericTemp) || numericTemp < -50 || numericTemp > 1800) {
      badRows.push(line)
      return
    }

    samples.push({
      id: `csv-${stamp}-${samples.length}`,
      timeMin: Number(timeMin.toFixed(2)),
      tempC: Number(numericTemp.toFixed(1)),
    })
  })

  if (!samples.length && badRows.length) {
    return { samples: [], badRows, reason: `全部 ${badRows.length} 行记录均无法识别，已隔离。` }
  }
  if (badRows.length) {
    return { samples, badRows, reason: `${badRows.length} 行异常记录已隔离。` }
  }
  return { samples, badRows }
}

/** 极简 CSV 分列：支持双引号包裹与逗号转义 */
function splitCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current)
      current = ''
    } else {
      current += char
    }
  }
  result.push(current)
  return result
}

export function downloadText(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
