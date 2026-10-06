import type { FiringSample } from '../types/firing'

export interface BadRow {
  line: number
  raw: string
  reason: string
}

export interface ParseTemperatureResult {
  samples: FiringSample[]
  badRows: BadRow[]
}

const TIME_HEADERS = ['time', 'minute', 'minutes', '时间', '分钟', '经过时间']
const TEMP_HEADERS = ['temp', 'temperature', 'temperature_c', '温度', '温度c', '实测温度']

function parseTimecode(raw: string): number {
  return raw
    .split(':')
    .reduce((total, value) => total * 60 + Number(value), 0) / 60
}

export function parseTemperatureCsv(content: string): ParseTemperatureResult {
  const badRows: BadRow[] = []
  const samples: FiringSample[] = []
  const lines = content
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length < 2) {
    return {
      samples,
      badRows: [{ line: 0, raw: '', reason: '文件为空或缺少表头行（需要 time,temp 两列）' }],
    }
  }

  const headers = lines[0].split(',').map((value) => value.trim().toLowerCase())
  const timeIndex = headers.findIndex((header) => TIME_HEADERS.includes(header))
  const tempIndex = headers.findIndex((header) => TEMP_HEADERS.includes(header))
  const actualTimeIndex = timeIndex >= 0 ? timeIndex : 0
  const actualTempIndex = tempIndex >= 0 ? tempIndex : 1

  let previousTime: number | null = null

  lines.slice(1).forEach((line, index) => {
    const lineNo = index + 2
    const values = line.split(',')
    const rawTime = values[actualTimeIndex]?.trim() ?? ''
    const rawTemp = values[actualTempIndex]?.trim() ?? ''

    if (!rawTime || !rawTemp) {
      badRows.push({ line: lineNo, raw: line, reason: '时间或温度字段为空' })
      return
    }

    const isTimecode = rawTime.includes(':')
    const timeValue = isTimecode ? parseTimecode(rawTime) : Number(rawTime)
    const tempValue = Number(rawTemp)

    if (Number.isNaN(timeValue)) {
      badRows.push({ line: lineNo, raw: line, reason: `时间「${rawTime}」无法解析` })
      return
    }
    if (Number.isNaN(tempValue)) {
      badRows.push({ line: lineNo, raw: line, reason: `温度「${rawTemp}」无法解析` })
      return
    }
    if (tempValue < -40 || tempValue > 1500) {
      badRows.push({ line: lineNo, raw: line, reason: `温度 ${tempValue} ℃ 超出窑炉合理范围（-40–1500）` })
      return
    }
    if (previousTime !== null && timeValue < previousTime) {
      badRows.push({ line: lineNo, raw: line, reason: `时间 ${timeValue} 分钟早于上一行 ${previousTime} 分钟，曲线非单调` })
      return
    }
    previousTime = timeValue

    samples.push({
      id: `csv-${Date.now()}-${index}`,
      timeMin: Number(timeValue.toFixed(2)),
      tempC: tempValue,
    })
  })

  return { samples, badRows }
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
