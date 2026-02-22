import type { VercelRequest, VercelResponse } from '@vercel/node'
import { google } from 'googleapis'
import { createClient } from '@supabase/supabase-js'

// ── Supabase client factory ──────────────────────────────────
function getSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) return null

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// ── Google OAuth client with token refresh ───────────────────
// This matches the logic in api/calendar/events.ts to ensure consistent auth
async function getAuthenticatedCalendar(supabase: any, userId: string) {
  if (!supabase) return null

  const { data: tokens, error: tokenError } = await supabase
    .from('google_calendar_tokens')
    .select('*')
    .eq('user_id', userId)
    .single()

  if (tokenError || !tokens) {
    if (tokenError && tokenError.code !== 'PGRST116') {
      console.error('[events/[id]] Token fetch error:', tokenError)
    }
    return null
  }

  // Use shared token refresh utility
  const { refreshGoogleToken } = await import('../_lib/tokenRefresh')
  const refreshResult = await refreshGoogleToken(
    tokens.access_token,
    tokens.refresh_token,
    tokens.expiry_date
  )

  // If refresh failed and token is expired, return null
  if (!refreshResult.success) {
    const now = Date.now()
    if (tokens.expiry_date - now < 0) {
      console.error('[events/[id]] Token expired and refresh failed:', refreshResult.error)
      return null
    }
    // If token is still valid, proceed with existing token
    console.warn('[events/[id]] Token refresh failed but using existing token:', refreshResult.error)
  }

  // Update token in database if refresh was successful
  if (refreshResult.success && refreshResult.accessToken !== tokens.access_token) {
    await supabase
      .from('google_calendar_tokens')
      .update({
        access_token: refreshResult.accessToken,
        expiry_date: refreshResult.expiryDate,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .catch((err) => {
        console.warn('[events/[id]] Failed to update token in database:', err)
      })
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  )
  oauth2Client.setCredentials({ access_token: refreshResult.accessToken })

  return google.calendar({ version: 'v3', auth: oauth2Client })
}

// ── Helper: Get Google Calendar ID from calendar ID ─────────────
async function getGoogleCalendarId(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  calendarId: string | null | undefined
): Promise<string> {
  // Default to primary calendar
  if (!calendarId || calendarId === 'primary') {
    return 'primary'
  }

  // Look up calendar in database
  const { data: calRecord, error } = await supabase
    .from('calendars')
    .select('google_calendar_id')
    .eq('id', calendarId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error && error.code !== 'PGRST116') {
    console.warn(`[events/[id]] Error looking up calendar ${calendarId}:`, error)
  }

  return calRecord?.google_calendar_id || 'primary'
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  const { id } = req.query
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Event ID is required' })
  }

  const authHeader = req.headers.authorization
  if (!authHeader) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const userId = req.query.user_id as string || (req.body && req.body.user_id) || null
  if (!userId) {
    return res.status(401).json({ error: 'User ID required' })
  }

  const supabase = getSupabase()
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase configuration missing' })
  }

  // Get authenticated calendar (this handles token refresh if needed)
  const calendar = await getAuthenticatedCalendar(supabase, userId)
  if (!calendar) {
    return res.status(401).json({ error: 'Google Calendar not connected or token expired' })
  }

  // ── PATCH: Update event using events.patch() ─────────────────
  if (req.method === 'PATCH') {
    try {
      const body = req.body

      // Determine target Google calendar ID (check query, then body)
      const requestedCalendarId = (req.query.calendarId as string) || body?.calendarId
      const googleCalendarId = await getGoogleCalendarId(supabase, userId, requestedCalendarId)

      console.log(`[PATCH] event=${id} calendar=${googleCalendarId} (requested=${requestedCalendarId})`)

      // Build start/end according to allDay flag
      // We must explicitly set the unused field (date vs dateTime) to null
      // so Google Calendar doesn't throw a 400 Bad Request if changing event type.
      let startField: any
      let endField: any

      if (body.allDay !== undefined) {
        if (body.allDay) {
          const startDate = typeof body.start === 'string' ? body.start.slice(0, 10) : undefined
          let endDate = typeof body.end === 'string' ? body.end.slice(0, 10) : undefined

          // Google Calendar requires all-day event end-dates to be exclusive
          if (startDate && startDate === endDate) {
            const d = new Date(startDate)
            d.setDate(d.getDate() + 1)
            endDate = d.toISOString().slice(0, 10)
          }

          if (startDate) startField = { date: startDate, dateTime: null }
          if (endDate) endField = { date: endDate, dateTime: null }
        } else {
          const tz = body.timeZone || 'Europe/Istanbul'
          // Normalize datetime strings to RFC3339 format (with seconds)
          // and pair with explicit timeZone so Google interprets correctly
          const { normalizeDateTimeForGoogle } = await import('../_lib/dateFormat')
          if (body.start) startField = { dateTime: normalizeDateTimeForGoogle(body.start), timeZone: tz, date: null }
          if (body.end) endField = { dateTime: normalizeDateTimeForGoogle(body.end), timeZone: tz, date: null }
        }
      } else {
        // Fallback if allDay is not provided (though our frontend sends it)
        const { normalizeDateTimeForGoogle } = await import('../_lib/dateFormat')
        if (body.start) {
          const isDateOnly = body.start.length === 10
          startField = isDateOnly
            ? { date: body.start }
            : { dateTime: normalizeDateTimeForGoogle(body.start), timeZone: body.timeZone || 'Europe/Istanbul' }
        }
        if (body.end) {
          const isDateOnly = body.end.length === 10
          endField = isDateOnly
            ? { date: body.end }
            : { dateTime: normalizeDateTimeForGoogle(body.end), timeZone: body.timeZone || 'Europe/Istanbul' }
        }
      }

      const patchBody: any = {}
      if (body.summary !== undefined) patchBody.summary = body.summary
      if (body.description !== undefined) patchBody.description = body.description || null
      if (body.location !== undefined) patchBody.location = body.location || null
      if (body.colorId !== undefined) patchBody.colorId = body.colorId ? String(body.colorId) : null
      if (startField) patchBody.start = startField
      if (endField) patchBody.end = endField

      const response = await calendar.events.patch({
        calendarId: googleCalendarId,
        eventId: id,
        requestBody: patchBody,
      })

      const ev = response.data
      return res.status(200).json({
        id: ev.id || '',
        summary: ev.summary || 'Başlıksız Etkinlik',
        description: ev.description || undefined,
        start: ev.start?.dateTime || ev.start?.date || '',
        end: ev.end?.dateTime || ev.end?.date || '',
        colorId: ev.colorId || undefined,
        location: ev.location || undefined,
        calendarId: requestedCalendarId || 'primary',
        allDay: !!ev.start?.date,
      })
    } catch (err: any) {
      // Handle specific Google API errors
      if (err.code === 401 || err.status === 401) {
        return res.status(401).json({ error: 'Google Calendar authentication failed', detail: err?.message })
      }
      if (err.code === 403 || err.status === 403) {
        return res.status(403).json({ error: 'Google Calendar access denied', detail: err?.message })
      }
      if (err.code === 404 || err.status === 404) {
        return res.status(404).json({ error: 'Event not found', detail: err?.message })
      }
      console.error('[events/[id] PATCH] Error updating event:', {
        message: err?.message,
        code: err?.code,
        status: err?.status,
      })
      return res.status(500).json({ error: 'Failed to update event', detail: err?.message })
    }
  }

  // ── DELETE: Remove event ─────────────────────────────────────
  if (req.method === 'DELETE') {
    try {
      // Determine target Google calendar ID (check query, then body)
      const requestedCalendarId = (req.query.calendarId as string) || req.body?.calendarId
      const googleCalendarId = await getGoogleCalendarId(supabase, userId, requestedCalendarId)

      console.log(`[DELETE] event=${id} calendar=${googleCalendarId} (requested=${requestedCalendarId})`)

      await calendar.events.delete({ calendarId: googleCalendarId, eventId: id })
      return res.status(204).end()
    } catch (err: any) {
      // Handle specific Google API errors
      if (err.code === 404 || err.code === 410 || err.status === 404 || err.status === 410) {
        // Event already deleted or not found - treat as success
        return res.status(204).end()
      }
      if (err.code === 401 || err.status === 401) {
        return res.status(401).json({ error: 'Google Calendar authentication failed', detail: err?.message })
      }
      if (err.code === 403 || err.status === 403) {
        return res.status(403).json({ error: 'Google Calendar access denied', detail: err?.message })
      }
      console.error('[events/[id] DELETE] Error deleting event:', {
        message: err?.message,
        code: err?.code,
        status: err?.status,
      })
      return res.status(500).json({ error: 'Failed to delete event', detail: err?.message })
    }
  }

  return res.status(405).json({ error: `Method ${req.method} not allowed` })
}
