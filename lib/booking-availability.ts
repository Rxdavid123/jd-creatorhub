export type AvailabilityInterval = {
  service_id?: string
  weekday: number
  start_time: string
  end_time: string
  enabled: boolean
}

export function normalizeTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^(?:([01]\d|2[0-3]):([0-5]\d))(?::([0-5]\d)(?:\.(\d{1,6}))?)?$/.exec(value)
  return match ? `${match[1]}:${match[2]}` : null
}

export function normalizeAvailabilityResponse<T extends { start_time: string; end_time: string }>(input: T[]): T[] | null {
  const rows = input.map((row) => {
    const start_time = normalizeTime(row.start_time)
    const end_time = normalizeTime(row.end_time)
    return start_time && end_time ? { ...row, start_time, end_time } : null
  })
  return rows.some((row) => row === null) ? null : rows as T[]
}

export function normalizeAvailabilityIntervals(input: unknown[]): { rows: AvailabilityInterval[]; error: string | null } {
  const rows = input.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { weekday: Number.NaN, start_time: '', end_time: '', enabled: false }
    }
    const row = value as Record<string, unknown>
    return {
      weekday: Number(row.weekday),
      start_time: normalizeTime(row.start_time) ?? '',
      end_time: normalizeTime(row.end_time) ?? '',
      enabled: row.enabled === true,
    }
  })

  if (rows.length > 70 || rows.some((row) =>
    !Number.isInteger(row.weekday) || row.weekday < 0 || row.weekday > 6 ||
    !normalizeTime(row.start_time) || !normalizeTime(row.end_time) || row.start_time >= row.end_time,
  )) {
    return { rows, error: 'Each interval must have a valid weekday and end after its start.' }
  }

  for (let weekday = 0; weekday < 7; weekday++) {
    const dayRows = rows.filter((row) => row.weekday === weekday && row.enabled).sort((a, b) => a.start_time.localeCompare(b.start_time))
    if (dayRows.some((row, index) => index > 0 && dayRows[index - 1].end_time > row.start_time)) {
      return { rows, error: 'Working intervals on the same day cannot overlap.' }
    }
  }

  return { rows, error: null }
}
