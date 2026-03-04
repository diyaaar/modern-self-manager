import { createContext, useContext, useState, useEffect, ReactNode, useCallback, useMemo, useRef } from 'react'
import { useAuth } from './AuthContext'
import { useToast } from './ToastContext'
import { Calendar as CalendarType } from '../types/calendar'

const SELECTED_CALENDARS_STORAGE_KEY = 'calendar-selected-ids'
const EVENTS_CACHE_EXPIRY = 5 * 60 * 1000 // 5 minutes

export interface CalendarEvent {
  id: string
  summary: string
  description?: string
  start: string
  end: string
  allDay?: boolean
  color?: string
  colorId?: string
  location?: string
  calendarId?: string // ID of the calendar this event belongs to
}

interface CalendarContextType {
  events: CalendarEvent[]
  calendars: CalendarType[]
  selectedCalendarIds: string[]
  loading: boolean
  error: string | null
  isAuthenticated: boolean
  fetchEvents: (date: Date, showLoading?: boolean) => Promise<void>
  fetchCalendars: () => Promise<void>
  toggleCalendar: (calendarId: string) => void
  createEvent: (event: Omit<CalendarEvent, 'id'>) => Promise<CalendarEvent | null>
  updateEvent: (id: string, updates: Partial<CalendarEvent>) => Promise<void>
  deleteEvent: (id: string) => Promise<void>
  connectGoogleCalendar: () => Promise<void>
  disconnectGoogleCalendar: () => Promise<void>
  syncEventsInBackground: (date: Date) => Promise<void>
  updateCurrentDate: (date: Date) => void
}

const CalendarContext = createContext<CalendarContextType | undefined>(undefined)

export function CalendarProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [calendars, setCalendars] = useState<CalendarType[]>([])

  // Load selected calendar IDs from localStorage
  const [selectedCalendarIds, setSelectedCalendarIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(SELECTED_CALENDARS_STORAGE_KEY)
      if (saved) {
        return JSON.parse(saved)
      }
    } catch (err) {
      console.warn('Failed to load calendar selection from localStorage:', err)
    }
    return []
  })

  const [loading, setLoading] = useState(false)
  const [initialLoad, setInitialLoad] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const eventsCacheRef = useRef<Map<string, { events: CalendarEvent[], timestamp: number }>>(new Map())
  const hasLoadedOnceRef = useRef(false)
  const syncIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const currentDateRef = useRef<Date>(new Date())

  // Check if user is authenticated with Google Calendar
  const checkAuthStatus = useCallback(async () => {
    if (!user) {
      setIsAuthenticated(false)
      return
    }

    try {
      // Check if user has tokens in Supabase
      const supabase = (await import('../lib/supabase')).getSupabaseClient()
      const { data, error } = await supabase
        .from('google_calendar_tokens')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle() // Use maybeSingle() instead of single() to handle no rows gracefully

      // Handle different error cases
      if (error) {
        // PGRST116 means no rows found (which is fine - user just hasn't connected)
        if (error.code === 'PGRST116' || error.message?.includes('No rows')) {
          setIsAuthenticated(false)
          return
        }
        // PGRST301 means table doesn't exist or RLS is blocking
        // For 406 errors, the message usually contains "Not Acceptable"
        if (error.code === 'PGRST301' || error.message?.includes('Not Acceptable') || error.message?.includes('406')) {
          console.warn('Google Calendar tokens table may not exist yet:', error.message)
          setIsAuthenticated(false)
          return
        }
        console.error('Error checking Google Calendar auth status:', error)
        setIsAuthenticated(false)
        return
      }

      setIsAuthenticated(!!data)
    } catch (err) {
      // Handle network errors or other exceptions gracefully
      console.warn('Error checking Google Calendar auth status (table may not exist):', err)
      setIsAuthenticated(false)
    }
  }, [user])

  // Fetch calendars
  const fetchCalendars = useCallback(async () => {
    if (!user) {
      setCalendars([])
      return
    }

    try {
      // First try to sync calendars from Google Calendar
      const syncResponse = await fetch(`/api/calendar/calendars?user_id=${user.id}`, {
        method: 'POST',
      })

      if (syncResponse.ok) {
        const syncData = await syncResponse.json()
        if (syncData.calendars && syncData.calendars.length > 0) {
          setCalendars(syncData.calendars)
          // If no calendars selected yet, select all by default
          if (selectedCalendarIds.length === 0) {
            setSelectedCalendarIds(syncData.calendars.map((c: CalendarType) => c.id))
          }
          return
        }
      }

      // Fallback: fetch from database directly
      const supabase = (await import('../lib/supabase')).getSupabaseClient()
      const { data, error } = await supabase
        .from('calendars')
        .select('*')
        .eq('user_id', user.id)
        .order('is_primary', { ascending: false })
        .order('name', { ascending: true })

      if (error) {
        // If table doesn't exist yet, that's okay - user just needs to create calendars
        if (error.code === 'PGRST301' || error.message?.includes('Not Acceptable') || error.message?.includes('406')) {
          console.warn('Calendars table may not exist yet:', error.message)
          setCalendars([])
          return
        }
        throw error
      }

      setCalendars(data || [])

      // If no calendars selected yet, check localStorage first, then select all by default
      if (selectedCalendarIds.length === 0 && data && data.length > 0) {
        try {
          const saved = localStorage.getItem(SELECTED_CALENDARS_STORAGE_KEY)
          if (saved) {
            const savedIds = JSON.parse(saved)
            // Only use saved IDs that still exist in calendars
            const validIds = savedIds.filter((id: string) => data.some((c: { id: string }) => c.id === id))
            if (validIds.length > 0) {
              setSelectedCalendarIds(validIds)
              return
            }
          }
        } catch (err) {
          console.warn('Failed to load calendar selection from localStorage:', err)
        }
        // Default: select all calendars
        const allIds = data.map((c: { id: string }) => c.id)
        setSelectedCalendarIds(allIds)
        localStorage.setItem(SELECTED_CALENDARS_STORAGE_KEY, JSON.stringify(allIds))
      }
    } catch (err) {
      console.error('Error fetching calendars:', err)
      setCalendars([])
    }
  }, [user, selectedCalendarIds.length])

  // Toggle calendar visibility and persist to localStorage
  const toggleCalendar = useCallback((calendarId: string) => {
    setSelectedCalendarIds(prev => {
      const newIds = prev.includes(calendarId)
        ? prev.filter(id => id !== calendarId)
        : [...prev, calendarId]

      // Persist to localStorage
      try {
        localStorage.setItem(SELECTED_CALENDARS_STORAGE_KEY, JSON.stringify(newIds))
      } catch (err) {
        console.warn('Failed to save calendar selection to localStorage:', err)
      }

      return newIds
    })
  }, [])

  // Persist selected calendar IDs whenever they change
  useEffect(() => {
    if (selectedCalendarIds.length > 0 || calendars.length > 0) {
      try {
        localStorage.setItem(SELECTED_CALENDARS_STORAGE_KEY, JSON.stringify(selectedCalendarIds))
      } catch (err) {
        console.warn('Failed to save calendar selection to localStorage:', err)
      }
    }
  }, [selectedCalendarIds, calendars.length])

  // Initialize auth check and fetch calendars
  useEffect(() => {
    checkAuthStatus()
    fetchCalendars()
  }, [checkAuthStatus, fetchCalendars])

  const connectGoogleCalendar = useCallback(async () => {
    try {
      if (!user) {
        showToast('Google Takvim\'i bağlamak için lütfen giriş yapın', 'error', 3000)
        return
      }
      // Redirect to OAuth endpoint with user_id
      window.location.href = `/api/calendar/auth/connect?user_id=${user.id}`
    } catch (err) {
      console.error('Error connecting Google Calendar:', err)
      showToast('Google Takvim bağlantısı başarısız oldu', 'error', 3000)
    }
  }, [user, showToast])

  const disconnectGoogleCalendar = useCallback(async () => {
    try {
      const response = await fetch('/api/calendar/auth/disconnect', {
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error('Bağlantı kesilemedi')
      }

      setIsAuthenticated(false)
      setEvents([])
      showToast('Google Takvim bağlantısı kesildi', 'success', 2000)
    } catch (err) {
      console.error('Error disconnecting Google Calendar:', err)
      showToast('Google Takvim bağlantısı kesilemedi', 'error', 3000)
    }
  }, [showToast])

  const fetchEvents = useCallback(async (date: Date, showLoading = false) => {
    if (!isAuthenticated || !user) return

    const startOfMonth = new Date(date.getFullYear(), date.getMonth(), 1)
    const endOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59)
    const cacheKey = `${startOfMonth.toISOString()}-${endOfMonth.toISOString()}`

    // Update current date ref for background sync
    currentDateRef.current = date

    // Check cache first
    const cached = eventsCacheRef.current.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < EVENTS_CACHE_EXPIRY) {
      setEvents(cached.events)
      if (initialLoad) {
        setInitialLoad(false)
      }
      return
    }

    // Only show loading on initial load or if explicitly requested
    if (showLoading || initialLoad) {
      setLoading(true)
    }
    setError(null)

    try {
      // Get Supabase session token for authentication
      const supabase = (await import('../lib/supabase')).getSupabaseClient()
      const { data: { session } } = await supabase.auth.getSession()

      if (!session) {
        throw new Error('Oturum açılmadı')
      }

      // Fetch ALL events (don't filter by selectedCalendarIds here - we'll filter in memory)
      // This allows smooth toggling without refetching
      const response = await fetch(
        `/api/calendar/events?timeMin=${startOfMonth.toISOString()}&timeMax=${endOfMonth.toISOString()}&user_id=${user.id}`,
        {
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
          },
        }
      )

      if (!response.ok) {
        throw new Error('Etkinlikler getirilemedi')
      }

      const data = await response.json()
      const fetchedEvents = data.events || []

      // Cache the events
      eventsCacheRef.current.set(cacheKey, {
        events: fetchedEvents,
        timestamp: Date.now()
      })

      setEvents(fetchedEvents)
      hasLoadedOnceRef.current = true
    } catch (err) {
      console.error('Error fetching events:', err)
      setError(err instanceof Error ? err.message : 'Failed to fetch events')
      // Only show toast on initial load or explicit errors
      if (initialLoad || showLoading) {
        showToast('Takvim etkinlikleri getirilemedi', 'error', 3000)
      }
    } finally {
      if (showLoading || initialLoad) {
        setLoading(false)
        setInitialLoad(false)
      }
    }
  }, [isAuthenticated, user, showToast, initialLoad])

  // Background sync: refresh events silently and detect changes
  const syncEventsInBackground = useCallback(async (date: Date) => {
    if (!isAuthenticated || !user || !hasLoadedOnceRef.current) return

    try {
      const startOfMonth = new Date(date.getFullYear(), date.getMonth(), 1)
      const endOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59)
      const cacheKey = `${startOfMonth.toISOString()}-${endOfMonth.toISOString()}`

      const supabase = (await import('../lib/supabase')).getSupabaseClient()
      const { data: { session } } = await supabase.auth.getSession()

      if (!session) return

      const response = await fetch(
        `/api/calendar/events?timeMin=${startOfMonth.toISOString()}&timeMax=${endOfMonth.toISOString()}&user_id=${user.id}`,
        {
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
          },
        }
      )

      if (response.ok) {
        const data = await response.json()
        const fetchedEvents = data.events || []

        // Compare with current events to detect changes
        const currentEvents = events
        const eventsChanged =
          currentEvents.length !== fetchedEvents.length ||
          currentEvents.some((currentEvent: CalendarEvent) => {
            const fetchedEvent = fetchedEvents.find((e: CalendarEvent) => e.id === currentEvent.id)
            if (!fetchedEvent) return true // Event was deleted
            // Check if event was updated (compare key fields)
            return (
              currentEvent.summary !== fetchedEvent.summary ||
              currentEvent.start !== fetchedEvent.start ||
              currentEvent.end !== fetchedEvent.end ||
              currentEvent.description !== fetchedEvent.description ||
              currentEvent.location !== fetchedEvent.location ||
              currentEvent.color !== fetchedEvent.color
            )
          }) ||
          fetchedEvents.some((fetchedEvent: CalendarEvent) => {
            // Check for new events
            return !currentEvents.find((e: CalendarEvent) => e.id === fetchedEvent.id)
          })

        // Only update if there are actual changes
        if (eventsChanged) {
          // Update cache
          eventsCacheRef.current.set(cacheKey, {
            events: fetchedEvents,
            timestamp: Date.now()
          })

          // Silently update events without showing loading
          setEvents(fetchedEvents)
        } else {
          // Update cache timestamp even if no changes (to keep cache fresh)
          eventsCacheRef.current.set(cacheKey, {
            events: fetchedEvents,
            timestamp: Date.now()
          })
        }
      }
    } catch (err) {
      // Silently fail in background sync
      console.warn('Background sync failed:', err)
    }
  }, [isAuthenticated, user, events])

  // Start periodic auto-sync
  useEffect(() => {
    if (!isAuthenticated || !user || !hasLoadedOnceRef.current) {
      // Clear interval if not authenticated
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current)
        syncIntervalRef.current = null
      }
      return
    }

    // Sync every 3 minutes (180000 ms)
    const SYNC_INTERVAL = 3 * 60 * 1000

    // Initial sync after a short delay
    const initialTimeout = setTimeout(() => {
      syncEventsInBackground(currentDateRef.current)
    }, 30000) // First sync after 30 seconds

    // Set up periodic sync
    syncIntervalRef.current = setInterval(() => {
      syncEventsInBackground(currentDateRef.current)
    }, SYNC_INTERVAL)

    return () => {
      clearTimeout(initialTimeout)
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current)
        syncIntervalRef.current = null
      }
    }
  }, [isAuthenticated, user, hasLoadedOnceRef.current, syncEventsInBackground])

  // Update current date ref when date changes
  const updateCurrentDate = useCallback((date: Date) => {
    currentDateRef.current = date
  }, [])

  const createEvent = useCallback(async (event: Omit<CalendarEvent, 'id'>): Promise<CalendarEvent | null> => {
    if (!isAuthenticated || !user) return null

    try {
      const supabase = (await import('../lib/supabase')).getSupabaseClient()
      const { data: { session } } = await supabase.auth.getSession()

      const response = await fetch('/api/calendar/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          ...event,
          user_id: user.id,
          // Forward all Google Calendar fields explicitly
          summary: event.summary,
          allDay: event.allDay,
          calendarId: event.calendarId,
          colorId: event.colorId,
          location: event.location,
          description: event.description,
        }),
      })

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        throw new Error(errData?.error || 'Etkinlik oluşturulamadı')
      }

      const newEvent = await response.json()
      // Invalidate cache so next fetch gets fresh events
      eventsCacheRef.current.clear()
      setEvents((prev) => [...prev, newEvent])
      showToast('Etkinlik başarıyla oluşturuldu', 'success', 2000)
      return newEvent
    } catch (err) {
      console.error('Error creating event:', err)
      showToast(err instanceof Error ? err.message : 'Etkinlik oluşturulamadı', 'error', 3000)
      return null
    }
  }, [isAuthenticated, user, showToast])

  const updateEvent = useCallback(async (id: string, updates: Partial<CalendarEvent>): Promise<void> => {
    if (!isAuthenticated || !user) return

    // --- Optimistic update ---
    const previousEvents = events
    setEvents(prev => prev.map(e => (e.id === id ? { ...e, ...updates } : e)))

    try {
      const supabase = (await import('../lib/supabase')).getSupabaseClient()
      const { data: { session } } = await supabase.auth.getSession()

      const currentEvent = previousEvents.find(e => e.id === id)
      const calendarId = currentEvent?.calendarId || 'primary'

      const response = await fetch(
        `/api/calendar/events/${id}?user_id=${user.id}&calendarId=${encodeURIComponent(calendarId)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
          },
          body: JSON.stringify({
            ...updates,
            // Make sure calendarId is in the body too (belt-and-suspenders)
            calendarId,
          }),
        }
      )

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        throw new Error(errData?.detail || errData?.error || 'Etkinlik güncellenemedi')
      }

      const updatedEvent = await response.json()
      // Sync with server's canonical response
      setEvents(prev => prev.map(e => (e.id === id ? { ...e, ...updatedEvent } : e)))
      showToast('Etkinlik başarıyla güncellendi', 'success', 2000)
    } catch (err) {
      console.error('Error updating event:', err)
      // --- Rollback ---
      setEvents(previousEvents)
      showToast(err instanceof Error ? err.message : 'Etkinlik güncellenemedi', 'error', 3000)
    }
  }, [isAuthenticated, user, events, showToast])

  const deleteEvent = useCallback(async (id: string): Promise<void> => {
    if (!isAuthenticated || !user) return

    // --- Optimistic removal ---
    const previousEvents = events
    setEvents(prev => prev.filter(e => e.id !== id))

    try {
      const supabase = (await import('../lib/supabase')).getSupabaseClient()
      const { data: { session } } = await supabase.auth.getSession()

      const currentEvent = previousEvents.find(e => e.id === id)
      const calendarId = currentEvent?.calendarId || 'primary'

      const response = await fetch(
        `/api/calendar/events/${id}?user_id=${user.id}&calendarId=${encodeURIComponent(calendarId)}`,
        {
          method: 'DELETE',
          headers: {
            ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
          },
        }
      )

      // 204 = success, 404/410 = already gone — both are fine
      if (!response.ok && response.status !== 204 && response.status !== 404 && response.status !== 410) {
        const errData = await response.json().catch(() => ({}))
        throw new Error(errData?.detail || errData?.error || 'Etkinlik silinemedi')
      }

      showToast('Etkinlik başarıyla silindi', 'success', 2000)
    } catch (err) {
      console.error('Error deleting event:', err)
      // --- Rollback ---
      setEvents(previousEvents)
      showToast(err instanceof Error ? err.message : 'Etkinlik silinemedi', 'error', 3000)
    }
  }, [isAuthenticated, user, events, showToast])

  // Filter events by selected calendars (memoized for performance)
  const filteredEvents = useMemo(() => {
    return events.filter(event => {
      // If event has no calendarId, show it (for backward compatibility)
      if (!event.calendarId) return true
      // Only show events from selected calendars
      return selectedCalendarIds.includes(event.calendarId)
    })
  }, [events, selectedCalendarIds])

  const value = useMemo(() => ({
    events: filteredEvents,
    calendars,
    selectedCalendarIds,
    loading: initialLoad ? loading : false, // Only show loading on initial load
    error,
    isAuthenticated,
    fetchEvents,
    fetchCalendars,
    toggleCalendar,
    createEvent,
    updateEvent,
    deleteEvent,
    connectGoogleCalendar,
    disconnectGoogleCalendar,
    syncEventsInBackground,
    updateCurrentDate,
  }), [
    filteredEvents,
    calendars,
    selectedCalendarIds,
    initialLoad,
    loading,
    error,
    isAuthenticated,
    fetchEvents,
    fetchCalendars,
    toggleCalendar,
    createEvent,
    updateEvent,
    deleteEvent,
    connectGoogleCalendar,
    disconnectGoogleCalendar,
    syncEventsInBackground,
    updateCurrentDate,
  ])

  return <CalendarContext.Provider value={value}>{children}</CalendarContext.Provider>
}

export function useCalendar() {
  const context = useContext(CalendarContext)
  if (context === undefined) {
    throw new Error('useCalendar must be used within a CalendarProvider')
  }
  return context
}

