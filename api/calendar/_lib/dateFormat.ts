/**
 * Date/time formatting utilities for Google Calendar API
 * Ensures consistent RFC3339 format required by Google Calendar
 */

/**
 * Normalize datetime string for Google Calendar API
 * 
 * Google Calendar API requires RFC3339 format: "YYYY-MM-DDTHH:mm:ss" or "YYYY-MM-DDTHH:mm:ss.sss"
 * This function:
 * 1. Removes any trailing 'Z' (UTC marker) or timezone offset (+HH:MM / -HH:MM)
 * 2. Ensures seconds are present (adds ":00" if missing)
 * 3. Returns a clean datetime string ready for Google Calendar API
 * 
 * @param dt - Datetime string in various formats (e.g., "2026-02-21T17:30", "2026-02-21T17:30:00Z", "2026-02-21T17:30:00+03:00")
 * @returns Normalized datetime string in format "YYYY-MM-DDTHH:mm:ss"
 */
export function normalizeDateTimeForGoogle(dt: string): string {
  if (!dt || typeof dt !== 'string') {
    throw new Error('Invalid datetime string provided')
  }

  // Remove trailing Z (UTC marker) or timezone offset (+HH:MM / -HH:MM)
  // This ensures Google Calendar interprets the time as a "wall clock" time
  // in the specified timeZone field, not as UTC
  let cleaned = dt.replace(/(Z|[+-]\d{2}:\d{2})$/, '')

  // Extract the date-time part (before any milliseconds)
  // Format should be: YYYY-MM-DDTHH:mm:ss or YYYY-MM-DDTHH:mm
  const dateTimeMatch = cleaned.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2})?(?:\.\d{1,3})?$/)
  
  if (!dateTimeMatch) {
    // If format doesn't match expected pattern, try to extract what we can
    const basicMatch = cleaned.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/)
    if (basicMatch) {
      cleaned = basicMatch[1]
    } else {
      throw new Error(`Invalid datetime format: ${dt}`)
    }
  } else {
    cleaned = dateTimeMatch[1]
  }

  // Ensure seconds are present (add ":00" if missing)
  // Google Calendar API requires seconds in RFC3339 format
  if (cleaned.length === 16) {
    // Format: "YYYY-MM-DDTHH:mm" - add seconds
    cleaned += ':00'
  } else if (cleaned.length === 19) {
    // Format: "YYYY-MM-DDTHH:mm:ss" - already has seconds, keep as is
    // Do nothing
  } else {
    // Unexpected length, try to fix
    const parts = cleaned.split('T')
    if (parts.length === 2) {
      const [date, time] = parts
      const timeParts = time.split(':')
      if (timeParts.length === 2) {
        // Only hours and minutes, add seconds
        cleaned = `${date}T${time}:00`
      } else if (timeParts.length === 3) {
        // Already has seconds, keep as is
        cleaned = `${date}T${timeParts[0]}:${timeParts[1]}:${timeParts[2]}`
      }
    }
  }

  // Final validation: ensure format is exactly "YYYY-MM-DDTHH:mm:ss"
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(cleaned)) {
    throw new Error(`Failed to normalize datetime: ${dt} -> ${cleaned}`)
  }

  return cleaned
}
