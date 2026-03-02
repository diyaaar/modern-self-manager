import type { VercelRequest, VercelResponse } from '@vercel/node'
import { google } from 'googleapis'
import { createClient } from '@supabase/supabase-js'

// ── Local types ──────────────────────────────────────────────
interface CalendarRecord {
  id: string
  google_calendar_id: string | null
  color: string
  name: string
  is_primary: boolean
}

// ── Supabase client factory ──────────────────────────────────
function getSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return null
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// ── Google OAuth client with token refresh ───────────────────
async function getAuthenticatedCalendar(supabase: ReturnType<typeof getSupabase>, userId: string) {
  if (!supabase) return null

  const { data: tokens, error: tokenError } = await supabase
    .from('google_calendar_tokens')
    .select('*')
    .eq('user_id', userId)
    .single()

  if (tokenError || !tokens) {
    if (tokenError && tokenError.code !== 'PGRST116') {
      console.error('[events] Token fetch error:', tokenError)
    }
    return null
  }

  // Refresh token if needed (inline implementation to avoid Vercel dynamic import issues)
  let accessToken = tokens.access_token
  const now = Date.now()

  // Proactively refresh if token expires within 5 minutes
  if (tokens.expiry_date - now < 5 * 60 * 1000) {
    try {
      const refreshResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          refresh_token: tokens.refresh_token,
          grant_type: 'refresh_token',
        }),
      })

      if (refreshResponse.ok) {
        const refreshData = await refreshResponse.json()
        accessToken = refreshData.access_token
        try {
          await supabase
            .from('google_calendar_tokens')
            .update({
              access_token: refreshData.access_token,
              expiry_date: Date.now() + (refreshData.expires_in * 1000),
              updated_at: new Date().toISOString(),
            })
            .eq('user_id', userId)
        } catch (err: any) {
          console.warn('[events] Failed to update token in database:', err)
        }
      }
    } catch (err) {
      console.warn('[events] Token refresh failed, proceeding with existing token:', err)
    }
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  )
  oauth2Client.setCredentials({ access_token: accessToken })

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
  const { data: calRecord, error } = await (supabase as any)
    .from('calendars')
    .select('google_calendar_id')
    .eq('id', calendarId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error && error.code !== 'PGRST116') {
    console.warn(`[events] Error looking up calendar ${calendarId}:`, error)
  }

  return calRecord?.google_calendar_id || 'primary'
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()

  const authHeader = req.headers.authorization
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' })

  // user_id can come from query string (GET) or request body (POST)
  const userId = (req.query.user_id as string) || (req.body?.user_id as string) || null
  if (!userId) return res.status(401).json({ error: 'User ID required' })

  const supabase = getSupabase()
  if (!supabase) {
    console.error('[events] Missing Supabase environment variables')
    return res.status(500).json({ error: 'Supabase configuration missing' })
  }

  // ── GET: Fetch events ────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { timeMin, timeMax, calendarIds } = req.query

      if (!timeMin || !timeMax) {
        return res.status(400).json({ error: 'timeMin and timeMax are required' })
      }

      const calendar = await getAuthenticatedCalendar(supabase, userId)
      if (!calendar) {
        return res.status(401).json({ error: 'Google Calendar not connected. Please reconnect.' })
      }

      const requestedCalendarIds = calendarIds
        ? (calendarIds as string).split(',').filter(Boolean)
        : []

      // Get user's calendars from database
      const { data: userCalendars } = await supabase
        .from('calendars')
        .select('*')
        .eq('user_id', userId)

      let calendarsToFetch: Array<{ id: string; googleId: string; color: string; name: string }> = []

      if (userCalendars && userCalendars.length > 0) {
        const filtered: CalendarRecord[] = requestedCalendarIds.length > 0
          ? userCalendars.filter((c: CalendarRecord) => requestedCalendarIds.includes(c.id))
          : userCalendars

        calendarsToFetch = filtered
          .filter((c: CalendarRecord) => c.google_calendar_id)
          .map((c: CalendarRecord) => ({
            id: c.id,
            googleId: c.google_calendar_id!,
            color: c.color,
            name: c.name,
          }))
      }

      if (calendarsToFetch.length === 0) {
        calendarsToFetch = [{ id: 'primary', googleId: 'primary', color: '#10b981', name: 'Primary' }]
      }

      const allEvents: Array<{
        id: string; summary: string; description?: string
        start: string; end: string; allDay: boolean
        colorId?: string; location?: string; calendarId: string; color?: string
      }> = []

      for (const cal of calendarsToFetch) {
        try {
          const response = await calendar.events.list({
            calendarId: cal.googleId,
            timeMin: timeMin as string,
            timeMax: timeMax as string,
            maxResults: 2500,
            singleEvents: true,
            orderBy: 'startTime',
          })

          const items = response.data.items || []
          for (const item of items) {
            if (!item?.id) continue
            const isAllDay = !item.start?.dateTime
            const start = item.start?.dateTime || item.start?.date || ''
            const end = item.end?.dateTime || item.end?.date || ''
            allEvents.push({
              id: item.id,
              summary: item.summary || 'Untitled Event',
              description: item.description || undefined,
              start,
              end,
              allDay: isAllDay,
              colorId: item.colorId || undefined,
              location: item.location || undefined,
              calendarId: cal.id,
              color: cal.color,
            })
          }
        } catch (err: any) {
          // Handle specific Google API errors
          if (err.code === 401 || err.status === 401) {
            console.error(`[events GET] Authentication failed for calendar ${cal.name}:`, err)
            // Continue with other calendars instead of failing completely
            continue
          }
          if (err.code === 403 || err.status === 403) {
            console.error(`[events GET] Access denied for calendar ${cal.name}:`, err)
            // Continue with other calendars instead of failing completely
            continue
          }
          console.error(`[events GET] Error fetching calendar ${cal.name}:`, {
            message: err?.message,
            code: err?.code,
            status: err?.status,
          })
        }
      }

      allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
      return res.status(200).json({ events: allEvents })

    } catch (err: any) {
      console.error('[events GET] Error:', err?.message)
      return res.status(500).json({ error: 'Failed to fetch events' })
    }
  }

  // ── POST: Create event ───────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const {
        summary, title,
        description,
        start, end,
        startDate, endDate,
        startDateTime, endDateTime,
        allDay,
        colorId,
        location,
        calendarId: requestedCalendarId,
        timeZone,
      } = req.body

      const eventTitle = (summary || title || '').trim()
      if (!eventTitle) {
        return res.status(400).json({ error: 'Event title (summary) is required' })
      }

      const calendar = await getAuthenticatedCalendar(supabase, userId)
      if (!calendar) {
        return res.status(401).json({ error: 'Google Calendar not connected. Please reconnect.' })
      }

      // Determine target Google calendar ID
      let googleCalendarId = 'primary'
      try {
        googleCalendarId = await getGoogleCalendarId(supabase, userId, requestedCalendarId)
      } catch (calIdErr: any) {
        console.error('[events POST] Error getting calendar ID:', calIdErr)
        // Continue with primary calendar if lookup fails
        googleCalendarId = 'primary'
      }

      // Always default to Europe/Istanbul for this app; never fall back to server-side UTC
      const tz = timeZone || 'Europe/Istanbul'

      // Build start/end for Google Calendar API (allDay uses date, timed uses dateTime)
      let googleStart: { date?: string; dateTime?: string; timeZone?: string }
      let googleEnd: { date?: string; dateTime?: string; timeZone?: string }

      const isAllDay = allDay === true || (typeof start === 'string' && start.length === 10)

      if (isAllDay) {
        const sDate = startDate || (typeof start === 'string' ? start.slice(0, 10) : null)
        let eDate = endDate || (typeof end === 'string' ? end.slice(0, 10) : sDate)
        if (!sDate) return res.status(400).json({ error: 'startDate is required for all-day events' })

        // Google Calendar requires all-day event end-dates to be exclusive
        if (sDate === eDate) {
          const d = new Date(sDate)
          d.setDate(d.getDate() + 1)
          eDate = d.toISOString().slice(0, 10)
        }

        googleStart = { date: sDate }
        googleEnd = { date: eDate || sDate }
      } else {
        const sDt = startDateTime || start
        const eDt = endDateTime || end
        if (!sDt || !eDt) return res.status(400).json({ error: 'start and end dateTime are required' })

        // IMPORTANT: Do NOT use new Date(...).toISOString() here.
        // toISOString() always converts to UTC and appends 'Z', which causes Google
        // Calendar to ignore the timeZone field, resulting in a +3h offset for Istanbul.
        // Instead, strip any trailing 'Z' or offset suffix and send the local datetime
        // string as-is, paired with an explicit IANA timeZone.
        // Ensure seconds are present for RFC3339 compliance
        const stripOffset = (dt: string) => {
          if (!dt || typeof dt !== 'string') {
            console.error('[events POST] Invalid datetime string:', dt)
            throw new Error(`Invalid datetime string: ${dt}`)
          }
          // Remove trailing Z (UTC marker) or +HH:MM / -HH:MM offset so the string
          // is treated as a "wall clock" time in the given timeZone.
          let cleaned = dt.replace(/(Z|[+-]\d{2}:\d{2})$/, '')
          // Normalize to YYYY-MM-DDTHH:mm:ss (19 chars) for RFC3339 compliance
          if (cleaned.length >= 19) {
            cleaned = cleaned.slice(0, 19)
          } else if (cleaned.length === 16) {
            cleaned += ':00'
          } else if (cleaned.length >= 10 && cleaned.length < 16) {
            // "YYYY-MM-DDTHH" or "YYYY-MM-DDTHH:m" etc - pad with :00
            cleaned = (cleaned + ':00').slice(0, 19)
          }
          return cleaned
        }

        try {
          googleStart = { dateTime: stripOffset(sDt), timeZone: tz }
          googleEnd = { dateTime: stripOffset(eDt), timeZone: tz }
        } catch (formatErr: any) {
          console.error('[events POST] Error formatting datetime:', {
            start: sDt,
            end: eDt,
            error: formatErr?.message,
          })
          return res.status(400).json({
            error: 'Invalid datetime format',
            detail: formatErr?.message || 'Failed to parse start/end datetime'
          })
        }
      }

      const eventResource = {
        summary: eventTitle,
        description: description || undefined,
        location: location || undefined,
        start: googleStart,
        end: googleEnd,
        colorId: colorId ? String(colorId) : undefined,
      }

      const response = await calendar.events.insert({
        calendarId: googleCalendarId,
        requestBody: eventResource,
      })

      const ev = response.data
      const evIsAllDay = !ev.start?.dateTime

      return res.status(200).json({
        id: ev.id || '',
        summary: ev.summary || 'Untitled Event',
        description: ev.description || undefined,
        start: ev.start?.dateTime || ev.start?.date || '',
        end: ev.end?.dateTime || ev.end?.date || '',
        allDay: evIsAllDay,
        colorId: ev.colorId || undefined,
        location: ev.location || undefined,
        calendarId: requestedCalendarId || 'primary',
      })

    } catch (err: any) {
      // Handle specific Google API errors
      if (err.code === 401 || err.status === 401) {
        return res.status(401).json({
          error: 'Google Calendar authentication failed',
          detail: err?.message,
        })
      }
      if (err.code === 403 || err.status === 403) {
        return res.status(403).json({
          error: 'Google Calendar access denied',
          detail: err?.message,
        })
      }
      console.error('[events POST] Error creating event:', {
        message: err?.message,
        code: err?.code,
        status: err?.status,
      })
      return res.status(500).json({
        error: 'Failed to create event',
        detail: err?.message,
      })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
