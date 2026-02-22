import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Trash2, AlignLeft, Calendar, Clock, Loader2 } from 'lucide-react'
import { LocationAutocomplete } from './LocationAutocomplete'
import { format, addHours } from 'date-fns'
import { useCalendar, CalendarEvent } from '../../contexts/CalendarContext'

// Google Calendar's 11 event colors
const GOOGLE_COLORS: { id: string; name: string; hex: string }[] = [
    { id: '1', name: 'Lavender', hex: '#a4bdfc' },
    { id: '2', name: 'Sage', hex: '#7ae7bf' },
    { id: '3', name: 'Grape', hex: '#dbadff' },
    { id: '4', name: 'Flamingo', hex: '#ff887c' },
    { id: '5', name: 'Banana', hex: '#fbd75b' },
    { id: '6', name: 'Tangerine', hex: '#ffb878' },
    { id: '7', name: 'Peacock', hex: '#46d6db' },
    { id: '8', name: 'Graphite', hex: '#e1e1e1' },
    { id: '9', name: 'Blueberry', hex: '#5484ed' },
    { id: '10', name: 'Basil', hex: '#51b749' },
    { id: '11', name: 'Tomato', hex: '#dc2127' },
]

interface EventFormModalProps {
    isOpen: boolean
    onClose: () => void
    /** Prefill with an existing event for edit mode */
    event?: CalendarEvent | null
    /** Prefill with a default start date/time for create mode */
    defaultStart?: Date
    defaultEnd?: Date
}

function toLocalDatetimeString(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day}T${hours}:${minutes}`
}

function toLocalDateString(date: Date): string {
    return format(date, 'yyyy-MM-dd')
}

export function EventFormModal({
    isOpen,
    onClose,
    event,
    defaultStart,
    defaultEnd,
}: EventFormModalProps) {
    const { createEvent, updateEvent, deleteEvent, calendars } = useCalendar()

    const isEditing = !!event

    // ── State ──────────────────────────────────────────────────
    const [title, setTitle] = useState('')
    const [allDay, setAllDay] = useState(false)
    const [startStr, setStartStr] = useState('')
    const [endStr, setEndStr] = useState('')
    const [calendarId, setCalendarId] = useState<string>('primary')
    const [colorId, setColorId] = useState<string>('')
    const [location, setLocation] = useState('')
    const [description, setDescription] = useState('')
    const [saving, setSaving] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // ── Initialize form ────────────────────────────────────────
    useEffect(() => {
        if (!isOpen) return
        setError(null)

        if (event) {
            // Edit mode: pre-fill from existing event
            setTitle(event.summary || '')
            setLocation(event.location || '')
            setDescription(event.description || '')
            setColorId(event.colorId || '')
            setCalendarId(event.calendarId || 'primary')

            const start = event.start ? new Date(event.start) : new Date()
            const end = event.end ? new Date(event.end) : addHours(start, 1)

            // Detect all-day: ISO date without time component
            const isAllDay = event.start?.length === 10
            setAllDay(isAllDay)
            if (isAllDay) {
                setStartStr(event.start)
                setEndStr(event.end)
            } else {
                setStartStr(toLocalDatetimeString(start))
                setEndStr(toLocalDatetimeString(end))
            }
        } else {
            // Create mode: use defaultStart or now
            const start = defaultStart ?? new Date()
            const end = defaultEnd ?? addHours(start, 1)
            setTitle('')
            setLocation('')
            setDescription('')
            setColorId('')
            // Default to first calendar in list (primary)
            const primaryCal = calendars.find(c => c.is_primary)
            setCalendarId(primaryCal?.id || calendars[0]?.id || 'primary')
            setAllDay(false)
            setStartStr(toLocalDatetimeString(start))
            setEndStr(toLocalDatetimeString(end))
        }
    }, [isOpen, event, defaultStart, defaultEnd, calendars])

    // ── Handlers ───────────────────────────────────────────────
    const handleAllDayToggle = useCallback(() => {
        setAllDay(prev => {
            const next = !prev
            if (next) {
                // Switch to date-only
                const date = startStr ? startStr.slice(0, 10) : toLocalDateString(new Date())
                setStartStr(date)
                setEndStr(date)
            } else {
                // Switch back to datetime
                const base = startStr ? new Date(startStr) : new Date()
                setStartStr(toLocalDatetimeString(base))
                setEndStr(toLocalDatetimeString(addHours(base, 1)))
            }
            return next
        })
    }, [startStr])

    const handleSave = useCallback(async () => {
        if (!title.trim()) {
            setError('Başlık zorunludur')
            return
        }
        if (!startStr || !endStr) {
            setError('Başlangıç ve bitiş tarihi/saati zorunludur')
            return
        }

        setSaving(true)
        setError(null)

        try {
            // Build the payload matching Google Calendar v3 schema.
            //
            // ⚠️  CRITICAL: Do NOT use new Date(startStr).toISOString() here.
            //     `startStr` comes from a <input type="datetime-local"> which yields
            //     a wall-clock string like "2026-02-21T17:30" with NO timezone info.
            //     Passing it to `new Date()` makes JS treat it as LOCAL time, then
            //     `.toISOString()` converts to UTC and appends 'Z' — for Istanbul
            //     (UTC+3) this results in a 3-hour backwards shift.
            //
            //     The correct approach: send the raw wall-clock string as-is and
            //     pair it with an explicit IANA timeZone. The server's `stripOffset`
            //     in api/calendar/events.ts already handles stripping any accidental
            //     suffix before forwarding to Google Calendar, which then interprets
            //     the time correctly in the declared timezone.
            let startPayload: string
            let endPayload: string

            if (allDay) {
                // For all-day events, send only the date part (YYYY-MM-DD)
                startPayload = startStr.slice(0, 10)
                endPayload = endStr.slice(0, 10)
            } else {
                // Send the datetime string in RFC3339 format (YYYY-MM-DDTHH:mm:ss)
                // Google Calendar API requires seconds in the datetime string.
                // The explicit timeZone field tells Google how to interpret it.
                // If seconds are missing, add ":00"
                const formatWithSeconds = (dt: string) => {
                    if (dt.length === 16) {
                        // Format: "YYYY-MM-DDTHH:mm" - add seconds
                        return dt + ':00'
                    } else if (dt.length >= 19) {
                        // Format already has seconds or more, take first 19 chars (YYYY-MM-DDTHH:mm:ss)
                        return dt.slice(0, 19)
                    }
                    return dt
                }
                startPayload = formatWithSeconds(startStr)
                endPayload = formatWithSeconds(endStr)
            }

            const payload: Omit<CalendarEvent, 'id'> & { timeZone?: string } = {
                summary: title.trim(),
                start: startPayload,
                end: endPayload,
                description: description || undefined,
                location: location || undefined,
                colorId: colorId || undefined,
                calendarId: calendarId || undefined,
                allDay,
                timeZone: allDay ? undefined : 'Europe/Istanbul',
            }

            if (isEditing && event) {
                await updateEvent(event.id, payload)
            } else {
                await createEvent(payload)
            }

            onClose()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Etkinlik kaydedilemedi')
        } finally {
            setSaving(false)
        }
    }, [title, startStr, endStr, allDay, description, location, colorId, calendarId, isEditing, event, createEvent, updateEvent, onClose])

    const handleDelete = useCallback(async () => {
        if (!event) return
        setDeleting(true)
        try {
            await deleteEvent(event.id)
            onClose()
        } catch {
            setError('Etkinlik silinemedi')
        } finally {
            setDeleting(false)
        }
    }, [event, deleteEvent, onClose])

    // ── Render ─────────────────────────────────────────────────
    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
                    onClick={onClose}
                >
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 10 }}
                        transition={{ type: 'spring', damping: 28, stiffness: 350 }}
                        className="w-full max-w-lg bg-[#0f172a] border border-white/10 rounded-2xl shadow-2xl overflow-visible"
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-5 py-4 border-b border-white/8">
                            <h2 className="text-lg font-semibold text-white">
                                {isEditing ? 'Etkinliği Düzenle' : 'Yeni Etkinlik'}
                            </h2>
                            <button
                                onClick={onClose}
                                className="p-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                                aria-label="Close"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Body */}
                        <div className="px-5 py-4 space-y-4 max-h-[calc(100vh-12rem)] overflow-y-auto">

                            {/* Error */}
                            {error && (
                                <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-3 py-2 rounded-lg">
                                    {error}
                                </div>
                            )}

                            {/* Title */}
                            <input
                                autoFocus
                                type="text"
                                placeholder="Etkinlik başlığı"
                                value={title}
                                onChange={e => setTitle(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
                                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-500 text-base font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500/60 transition-all"
                            />

                            {/* All-day toggle */}
                            <div className="flex items-center gap-3">
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={allDay}
                                    onClick={handleAllDayToggle}
                                    className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 ${allDay ? 'bg-emerald-500' : 'bg-white/15'
                                        }`}
                                >
                                    <span
                                        className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${allDay ? 'translate-x-5' : 'translate-x-0'
                                            }`}
                                    />
                                </button>
                                <span className="text-sm text-slate-400">Tüm gün</span>
                            </div>

                            {/* Date/Time */}
                            <div className="grid grid-cols-2 gap-3">
                                <div className="space-y-1">
                                    <label className="flex items-center gap-1.5 text-xs font-medium text-slate-500 uppercase tracking-wide">
                                        <Clock className="w-3 h-3" />
                                        {allDay ? 'Başlangıç tarihi' : 'Başlangıç'}
                                    </label>
                                    <input
                                        type={allDay ? 'date' : 'datetime-local'}
                                        value={startStr}
                                        onChange={e => setStartStr(e.target.value)}
                                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/60 transition-all [color-scheme:dark]"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="flex items-center gap-1.5 text-xs font-medium text-slate-500 uppercase tracking-wide">
                                        <Clock className="w-3 h-3" />
                                        {allDay ? 'Bitiş tarihi' : 'Bitiş'}
                                    </label>
                                    <input
                                        type={allDay ? 'date' : 'datetime-local'}
                                        value={endStr}
                                        onChange={e => setEndStr(e.target.value)}
                                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/60 transition-all [color-scheme:dark]"
                                    />
                                </div>
                            </div>

                            {/* Calendar selector */}
                            {calendars.length > 0 && (
                                <div className="space-y-1">
                                    <label className="flex items-center gap-1.5 text-xs font-medium text-slate-500 uppercase tracking-wide">
                                        <Calendar className="w-3 h-3" />
                                        Takvim
                                    </label>
                                    <select
                                        value={calendarId}
                                        onChange={e => setCalendarId(e.target.value)}
                                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/60 transition-all [color-scheme:dark] cursor-pointer"
                                    >
                                        {calendars.map(cal => (
                                            <option key={cal.id} value={cal.id} style={{ background: '#0f172a' }}>
                                                {cal.name}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {/* Color picker */}
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                                    Renk
                                </label>
                                <div className="flex flex-wrap gap-2">
                                    {/* Default: use calendar color */}
                                    <button
                                        type="button"
                                        onClick={() => setColorId('')}
                                        className={`w-6 h-6 rounded-full border-2 transition-all ${colorId === '' ? 'border-white scale-110' : 'border-transparent hover:border-white/40'
                                            } bg-emerald-500`}
                                        title="Varsayılan (takvim rengi)"
                                        aria-label="Varsayılan renk"
                                    />
                                    {GOOGLE_COLORS.map(c => (
                                        <button
                                            key={c.id}
                                            type="button"
                                            onClick={() => setColorId(colorId === c.id ? '' : c.id)}
                                            className={`w-6 h-6 rounded-full border-2 transition-all ${colorId === c.id ? 'border-white scale-110' : 'border-transparent hover:border-white/40'
                                                }`}
                                            style={{ backgroundColor: c.hex }}
                                            title={c.name}
                                            aria-label={c.name}
                                        />
                                    ))}
                                </div>
                            </div>

                            {/* Location — OSM/Nominatim autocomplete (no paid API) */}
                            <LocationAutocomplete
                                value={location}
                                onChange={setLocation}
                                placeholder="Konum ekle"
                            />

                            {/* Description */}
                            <div className="relative">
                                <AlignLeft className="absolute left-3 top-3 w-4 h-4 text-slate-500" />
                                <textarea
                                    placeholder="Açıklama ekle"
                                    value={description}
                                    onChange={e => setDescription(e.target.value)}
                                    rows={3}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 pl-9 text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/60 transition-all resize-none"
                                />
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="flex items-center justify-between px-5 py-4 border-t border-white/8 gap-3">
                            {/* Delete (edit mode only) */}
                            {isEditing ? (
                                <button
                                    type="button"
                                    onClick={handleDelete}
                                    disabled={deleting || saving}
                                    className="flex items-center gap-1.5 px-3 py-2 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50"
                                >
                                    {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                                    Sil
                                </button>
                            ) : <div />}

                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="px-4 py-2 text-sm text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                                >
                                    İptal
                                </button>
                                <button
                                    type="button"
                                    onClick={handleSave}
                                    disabled={saving || deleting}
                                    className="flex items-center gap-2 px-5 py-2 bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-semibold rounded-lg transition-colors shadow-lg shadow-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                    {isEditing ? 'Değişiklikleri kaydet' : 'Etkinlik oluştur'}
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}
