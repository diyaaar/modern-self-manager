// ============================================================
// TRANSACTION FORM — CREATE and EDIT modes
// Modal rendered via Portal to escape framer-motion transform context.
// AI Receipt Auto-Fill: gpt-4o-mini via /api/finance/analyze-receipt
// ============================================================

import { useState, useRef, useCallback, useEffect } from 'react'
import { X, TrendingUp, TrendingDown, Upload, Paperclip, Camera, Sparkles, Loader2, AlertTriangle, Plus, ExternalLink, Trash2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useFinance } from '../../../contexts/FinanceContext'
import { FinanceTransaction, formatInputAmountTl } from '../types/finance.types'
import { Portal } from '../../../components/Portal'
import { getReceiptUrl } from '../../../lib/financeStorage'
import { ReceiptViewer } from './ReceiptViewer'
import { pdfFirstPageToPngBase64 } from '../../../lib/pdfToImage'

interface TransactionFormProps {
    onClose: () => void
    onSuccess?: (txn: FinanceTransaction) => void
    presetType?: 'income' | 'expense'
    presetObligationId?: string
    /** If provided, the form opens in EDIT mode pre-populated with this transaction */
    editingTransaction?: FinanceTransaction
}

interface ReceiptAnalysisResult {
    type: 'income' | 'expense'
    amountKurus: number
    amountTl: string
    date: string
    note: string
    matched_category_id: string | null
    suggested_new_category_name: string | null
}

export function TransactionForm({ onClose, onSuccess, presetType, presetObligationId, editingTransaction }: TransactionFormProps) {
    const { categories, obligations, getTagsForCategory, createTransaction, createCategory, updateTransactionWithReceipt } = useFinance()

    const isEdit = !!editingTransaction

    const now = new Date()
    const localDatetime = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)

    // Pre-populate from editingTransaction if in edit mode
    const initType = editingTransaction?.type ?? presetType ?? 'expense'
    const initAmountTl = editingTransaction ? (() => {
        const [intPart, decPart] = (editingTransaction.amount / 100).toFixed(2).split('.')
        const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
        return `${formattedInt},${decPart}`
    })() : ''
    const initCategoryId = editingTransaction?.category_id ?? ''
    const initTagId = editingTransaction?.tag_id ?? ''
    const initObligationId = editingTransaction?.obligation_id ?? presetObligationId ?? ''
    const initDatetimeLocal = editingTransaction
        ? (() => {
            const d = new Date(editingTransaction.occurred_at)
            return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
        })()
        : localDatetime
    const initDateStr = initDatetimeLocal.slice(0, 10)
    const initTimeStr = initDatetimeLocal.slice(11, 16)
    const initNote = editingTransaction?.note ?? ''

    const [type, setType] = useState<'income' | 'expense'>(initType)
    const [amountTl, setAmountTl] = useState(initAmountTl)
    const [currency, setCurrency] = useState<'TRY' | 'USD' | 'EUR'>(
        (editingTransaction?.currency as 'TRY' | 'USD' | 'EUR') ?? 'TRY'
    )
    const [exchangeRates, setExchangeRates] = useState<{ USD: number; EUR: number } | null>(null)
    const [ratesLoading, setRatesLoading] = useState(false)
    const [categoryId, setCategoryId] = useState(initCategoryId)
    const [tagId, setTagId] = useState(initTagId)
    const [obligationId, setObligationId] = useState(initObligationId)
    const [dateStr, setDateStr] = useState(initDateStr)   // YYYY-MM-DD
    const [timeStr, setTimeStr] = useState(initTimeStr)   // HH:mm
    const [note, setNote] = useState(initNote)

    // Receipt state
    const [receiptFile, setReceiptFile] = useState<File | null>(null)
    const [removeExistingReceipt, setRemoveExistingReceipt] = useState(false)

    const [submitting, setSubmitting] = useState(false)
    const [viewingReceipt, setViewingReceipt] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    // AI scan state
    const [isScanning, setIsScanning] = useState(false)
    const [scanError, setScanError] = useState<string | null>(null)
    const [suggestedCategoryName, setSuggestedCategoryName] = useState<string | null>(null)
    const [creatingCategory, setCreatingCategory] = useState(false)

    const fileInputRef = useRef<HTMLInputElement>(null)
    const cameraInputRef = useRef<HTMLInputElement>(null)
    const timeInputRef = useRef<HTMLInputElement>(null)

    // Fetch exchange rates on mount (non-blocking)
    useEffect(() => {
        setRatesLoading(true)
        fetch('/api/finance/exchange-rates')
            .then((r) => r.json())
            .then((data) => {
                if (data?.rates?.USD && data?.rates?.EUR) {
                    setExchangeRates({ USD: data.rates.USD, EUR: data.rates.EUR })
                }
            })
            .catch(() => { /* silently ignore — form works without rates */ })
            .finally(() => setRatesLoading(false))
    }, [])

    const currencySymbol = currency === 'TRY' ? '₺' : currency === 'USD' ? '$' : '€'

    // Combine date+time into ISO string for submission
    const buildOccurredAt = useCallback(() => {
        const combined = `${dateStr}T${timeStr || '00:00'}:00`
        return new Date(combined).toISOString()
    }, [dateStr, timeStr])

    const filteredCategories = categories.filter((c) => c.type === type)
    const availableTags = categoryId ? getTagsForCategory(categoryId) : []
    const openObligations = obligations.filter((o) => !o.is_closed)

    // The existing receipt path from the transaction (only relevant in edit mode)
    const existingReceiptPath = editingTransaction?.receipt_path ?? null
    const showExistingReceipt = isEdit && existingReceiptPath && !removeExistingReceipt && !receiptFile

    const handleCategoryChange = (id: string) => {
        setCategoryId(id)
        setTagId('')
        setSuggestedCategoryName(null)
    }

    const handleTypeChange = (newType: 'income' | 'expense') => {
        setType(newType)
        setCategoryId('')
        setTagId('')
        setSuggestedCategoryName(null)
    }

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0] || null
        setReceiptFile(file)
        setRemoveExistingReceipt(false)
        setScanError(null)
        setSuggestedCategoryName(null)
    }

    const handleRemoveExistingReceipt = () => {
        setRemoveExistingReceipt(true)
    }

    // ── AI Receipt Scanner ──────────────────────────────────
    const handleScanReceipt = async () => {
        if (!receiptFile) return

        setIsScanning(true)
        setScanError(null)
        setSuggestedCategoryName(null)

        try {
            let base64: string
            let mimeType: string

            if (receiptFile.type === 'application/pdf') {
                // PDF: render first page to high-quality PNG via pdf.js (CDN)
                base64 = await pdfFirstPageToPngBase64(receiptFile)
                mimeType = 'image/png'
            } else {
                // Image: read directly as base64
                base64 = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader()
                    reader.onload = () => resolve((reader.result as string).split(',')[1])
                    reader.onerror = () => reject(new Error('Dosya okunamadı'))
                    reader.readAsDataURL(receiptFile)
                })
                mimeType = receiptFile.type || 'image/jpeg'
            }

            const response = await fetch('/api/finance/analyze-receipt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    imageBase64: base64,
                    imageMimeType: mimeType,
                    categories: categories.map((c) => ({
                        id: c.id,
                        name: c.name,
                        type: c.type,
                    })),
                }),
            })

            if (!response.ok) {
                const { error: errMsg } = await response.json().catch(() => ({ error: 'Bilinmeyen hata' }))
                throw new Error(errMsg || `Sunucu hatası: ${response.status}`)
            }

            const result: ReceiptAnalysisResult = await response.json()

            setType(result.type)
            setAmountTl(result.amountTl)
            setNote(result.note)

            if (result.date) {
                setDateStr(result.date)
            }

            if (result.matched_category_id) {
                setCategoryId(result.matched_category_id)
                setTagId('')
            } else if (result.suggested_new_category_name) {
                setSuggestedCategoryName(result.suggested_new_category_name)
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Fiş analiz edilemedi'
            setScanError(msg)
        } finally {
            setIsScanning(false)
        }
    }

    // ── Quick-create suggested category ──────────────────────
    const handleCreateSuggestedCategory = async () => {
        if (!suggestedCategoryName) return
        setCreatingCategory(true)
        try {
            const newCat = await createCategory({
                type,
                name: suggestedCategoryName,
                color: '#f59e0b',
            })
            if (newCat) {
                setCategoryId(newCat.id)
                setTagId('')
                setSuggestedCategoryName(null)
            }
        } finally {
            setCreatingCategory(false)
        }
    }

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        setError(null)

        // Parse amount — strip thousand-separator dots, replace comma with dot
        const rawAmount = amountTl.replace(/\./g, '').replace(',', '.')
        if (!rawAmount || parseFloat(rawAmount) <= 0) {
            setError('Geçerli bir tutar girin')
            return
        }

        // Build occurred_at from split date+time state
        const occurredAtIso = buildOccurredAt()

        setSubmitting(true)
        try {
            if (isEdit && editingTransaction) {
                // ── EDIT MODE ──
                const amountKurus = Math.round(parseFloat(rawAmount) * 100)
                await updateTransactionWithReceipt(
                    editingTransaction.id,
                    {
                        type,
                        amount: amountKurus,
                        currency,
                        category_id: categoryId || null,
                        tag_id: tagId || null,
                        obligation_id: obligationId || null,
                        occurred_at: occurredAtIso,
                        note: note.trim() || null,
                    },
                    {
                        newReceiptFile: receiptFile,
                        removeExistingReceipt,
                        existingReceiptPath,
                    }
                )
                onClose()
            } else {
                // ── CREATE MODE ──
                const txn = await createTransaction({
                    type,
                    amountTl,
                    currency,
                    category_id: categoryId || undefined,
                    tag_id: tagId || undefined,
                    obligation_id: obligationId || undefined,
                    occurred_at: occurredAtIso,
                    note: note.trim() || undefined,
                    receiptFile,
                })
                if (txn) {
                    onSuccess?.(txn)
                    onClose()
                }
            }
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <Portal>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-50 flex items-center justify-center p-4"
                onClick={(e: React.MouseEvent<HTMLDivElement>) => e.target === e.currentTarget && onClose()}
            >
                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

                <motion.div
                    initial={{ scale: 0.95, opacity: 0, y: 20 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.95, opacity: 0, y: 20 }}
                    transition={{ type: 'spring', bounce: 0.2 }}
                    className="relative w-full max-w-lg bg-background-secondary border border-white/10 rounded-2xl shadow-2xl flex flex-col max-h-[calc(100vh-2rem)]"
                >
                    {/* Header */}
                    <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
                        <h2 className="text-lg font-semibold text-white">
                            {isEdit ? 'İşlemi Düzenle' : 'Yeni İşlem'}
                        </h2>
                        <button
                            onClick={onClose}
                            className="p-1.5 rounded-lg text-text-tertiary hover:text-white hover:bg-white/10 transition-all"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    <form onSubmit={handleSubmit} className="p-6 space-y-5 flex-1 overflow-y-auto">
                        {/* Type Toggle */}
                        <div className="flex gap-2 p-1 bg-background-elevated rounded-xl">
                            {(['income', 'expense'] as const).map((t) => (
                                <button
                                    key={t}
                                    type="button"
                                    onClick={() => handleTypeChange(t)}
                                    className={`
                    flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all duration-200
                    ${type === t
                                            ? t === 'income'
                                                ? 'bg-success/20 text-success border border-success/30'
                                                : 'bg-danger/20 text-danger border border-danger/30'
                                            : 'text-text-tertiary hover:text-text-primary'
                                        }
                  `}
                                >
                                    {t === 'income' ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                                    {t === 'income' ? 'Gelir' : 'Gider'}
                                </button>
                            ))}
                        </div>

                        {/* Amount + Currency */}
                        <div>
                            <label className="block text-xs font-medium text-text-tertiary mb-1.5">Tutar</label>
                            <div className="flex gap-2">
                                {/* Amount input */}
                                <div className="relative flex-1">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary font-medium">{currencySymbol}</span>
                                    <input
                                        type="text"
                                        inputMode="decimal"
                                        value={amountTl}
                                        onChange={(e) => {
                                            setAmountTl(formatInputAmountTl(e.target.value))
                                        }}
                                        placeholder="0,00"
                                        required
                                        className="w-full pl-8 pr-4 py-2.5 bg-background-elevated border border-white/10 rounded-xl text-white placeholder-text-tertiary focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-all text-lg font-semibold"
                                    />
                                </div>

                                {/* Currency selector */}
                                <div className="flex gap-1 p-1 bg-background-elevated border border-white/10 rounded-xl">
                                    {(['TRY', 'USD', 'EUR'] as const).map((c) => (
                                        <button
                                            key={c}
                                            type="button"
                                            onClick={() => setCurrency(c)}
                                            className={`
                                                px-2.5 py-1 rounded-lg text-xs font-semibold transition-all duration-150
                                                ${currency === c
                                                    ? 'bg-primary/20 text-primary border border-primary/30'
                                                    : 'text-text-tertiary hover:text-text-primary'
                                                }
                                            `}
                                        >
                                            {c === 'TRY' ? '₺ TL' : c === 'USD' ? '$ USD' : '€ EUR'}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Exchange rate badge */}
                            {currency !== 'TRY' && (
                                <div className="mt-1.5 flex items-center gap-1.5">
                                    {ratesLoading ? (
                                        <span className="text-xs text-text-tertiary animate-pulse">Kur yükleniyor...</span>
                                    ) : exchangeRates ? (
                                        <span className="text-xs text-text-tertiary">
                                            1 {currency} ≈{' '}
                                            <span className="text-text-secondary font-medium">
                                                {exchangeRates[currency].toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺
                                            </span>
                                        </span>
                                    ) : (
                                        <span className="text-xs text-text-tertiary opacity-50">Kur bilgisi alınamadı</span>
                                    )}
                                </div>
                            )}
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            {/* Category */}
                            <div>
                                <label className="block text-xs font-medium text-text-tertiary mb-1.5">Kategori</label>
                                <select
                                    value={categoryId}
                                    onChange={(e) => handleCategoryChange(e.target.value)}
                                    className="w-full px-3 py-2.5 bg-background-elevated border border-white/10 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all text-sm appearance-none"
                                >
                                    <option value="">Seçiniz...</option>
                                    {filteredCategories.map((cat) => (
                                        <option key={cat.id} value={cat.id}>{cat.name}</option>
                                    ))}
                                </select>
                            </div>

                            {/* Tag */}
                            <AnimatePresence>
                                {categoryId && availableTags.length > 0 && (
                                    <motion.div
                                        initial={{ opacity: 0, x: 10 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        exit={{ opacity: 0, x: 10 }}
                                    >
                                        <label className="block text-xs font-medium text-text-tertiary mb-1.5">Etiket</label>
                                        <select
                                            value={tagId}
                                            onChange={(e) => setTagId(e.target.value)}
                                            className="w-full px-3 py-2.5 bg-background-elevated border border-white/10 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all text-sm appearance-none"
                                        >
                                            <option value="">Seçiniz...</option>
                                            {availableTags.map((tag) => (
                                                <option key={tag.id} value={tag.id}>{tag.name}</option>
                                            ))}
                                        </select>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>

                        {/* AI Suggested Category Banner */}
                        <AnimatePresence>
                            {suggestedCategoryName && !categoryId && (
                                <motion.div
                                    initial={{ opacity: 0, y: -8 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -8 }}
                                    className="flex items-center justify-between gap-3 px-3 py-2.5 bg-amber-500/10 border border-amber-500/30 rounded-xl"
                                >
                                    <div className="flex items-center gap-2 min-w-0">
                                        <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                                        <span className="text-xs text-amber-300 truncate">
                                            Önerilen: <span className="font-semibold text-amber-200">{suggestedCategoryName}</span>
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        <button
                                            type="button"
                                            onClick={handleCreateSuggestedCategory}
                                            disabled={creatingCategory}
                                            className="flex items-center gap-1 px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 rounded-lg text-xs font-medium transition-all disabled:opacity-60"
                                        >
                                            {creatingCategory ? (
                                                <Loader2 className="w-3 h-3 animate-spin" />
                                            ) : (
                                                <Plus className="w-3 h-3" />
                                            )}
                                            Oluştur ve Seç
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setSuggestedCategoryName(null)}
                                            className="p-1 text-amber-400/60 hover:text-amber-300 transition-colors"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {/* Date + Time — split inputs so date picker closes on single-click */}
                        <div>
                            <label className="block text-xs font-medium text-text-tertiary mb-1.5">Tarih & Saat</label>
                            <div className="flex gap-2">
                                <input
                                    type="date"
                                    value={dateStr}
                                    onChange={(e) => {
                                        setDateStr(e.target.value)
                                        // Blur to close native picker, then focus time
                                        e.target.blur()
                                        setTimeout(() => timeInputRef.current?.focus(), 50)
                                    }}
                                    required
                                    className="flex-1 px-3 py-2.5 bg-background-elevated border border-white/10 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all text-sm"
                                />
                                <input
                                    ref={timeInputRef}
                                    type="time"
                                    value={timeStr}
                                    onChange={(e) => setTimeStr(e.target.value)}
                                    className="w-28 px-3 py-2.5 bg-background-elevated border border-white/10 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all text-sm"
                                />
                            </div>
                        </div>

                        {/* Link to Obligation */}
                        {openObligations.length > 0 && (
                            <div>
                                <label className="block text-xs font-medium text-text-tertiary mb-1.5">Yükümlülüğe Bağla (opsiyonel)</label>
                                <select
                                    value={obligationId}
                                    onChange={(e) => setObligationId(e.target.value)}
                                    className="w-full px-3 py-2.5 bg-background-elevated border border-white/10 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all text-sm appearance-none"
                                >
                                    <option value="">Bağlama</option>
                                    {openObligations.map((ob) => (
                                        <option key={ob.id} value={ob.id}>{ob.description}</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {/* Note */}
                        <div>
                            <label className="block text-xs font-medium text-text-tertiary mb-1.5">Not</label>
                            <textarea
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                placeholder="Açıklama..."
                                rows={2}
                                className="w-full px-3 py-2.5 bg-background-elevated border border-white/10 rounded-xl text-white placeholder-text-tertiary focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all text-sm resize-none"
                            />
                        </div>

                        {/* Receipt Upload — File & Camera */}
                        <div className="space-y-2">
                            <label className="block text-xs font-medium text-text-tertiary">Fiş / Fatura</label>

                            {/* Existing receipt row (edit mode only) */}
                            {showExistingReceipt && (
                                <div className="flex items-center gap-2 px-3 py-2 bg-background-elevated border border-white/10 rounded-lg">
                                    <Paperclip className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
                                    <span className="text-text-secondary text-xs flex-1 truncate">Mevcut fiş</span>
                                    <button
                                        type="button"
                                        onClick={() => setViewingReceipt(getReceiptUrl(editingTransaction.receipt_path!))}
                                        className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-white/5 hover:bg-white/10 text-white rounded-lg transition-colors text-xs"
                                    >
                                        Görüntüle
                                        <ExternalLink className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleRemoveExistingReceipt}
                                        className="p-1 text-text-tertiary hover:text-danger transition-colors"
                                        title="Fişi kaldır"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            )}

                            {/* New file selected */}
                            {receiptFile && (
                                <div className="flex items-center gap-2 px-3 py-2 bg-primary/10 border border-primary/20 rounded-lg">
                                    <Paperclip className="w-3.5 h-3.5 text-primary shrink-0" />
                                    <span className="text-primary text-xs truncate flex-1">{receiptFile.name}</span>
                                    <button
                                        type="button"
                                        onClick={() => { setReceiptFile(null); setScanError(null); setSuggestedCategoryName(null) }}
                                        className="text-text-tertiary hover:text-white transition-colors"
                                    >
                                        <X className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            )}

                            {/* Upload buttons */}
                            {!showExistingReceipt && !receiptFile && (
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        onClick={() => fileInputRef.current?.click()}
                                        className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 border border-dashed border-white/20 rounded-xl text-text-tertiary hover:text-white hover:border-primary/40 transition-all text-xs"
                                    >
                                        <Upload className="w-3.5 h-3.5" />
                                        <span>Dosya Seç</span>
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => cameraInputRef.current?.click()}
                                        className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 border border-dashed border-white/20 rounded-xl text-text-tertiary hover:text-white hover:border-primary/40 transition-all text-xs"
                                    >
                                        <Camera className="w-3.5 h-3.5" />
                                        <span>Kamera</span>
                                    </button>
                                </div>
                            )}

                            {/* Replace button shown when existing receipt is displayed */}
                            {showExistingReceipt && (
                                <button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    className="w-full flex items-center justify-center gap-2 px-3 py-2 border border-dashed border-white/20 rounded-xl text-text-tertiary hover:text-white hover:border-primary/40 transition-all text-xs"
                                >
                                    <Upload className="w-3.5 h-3.5" />
                                    <span>Fişi değiştir</span>
                                </button>
                            )}

                            {/* Hidden file inputs */}
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/jpeg,image/png,image/gif,image/webp,application/pdf"
                                onChange={handleFileSelect}
                                className="hidden"
                            />
                            <input
                                ref={cameraInputRef}
                                type="file"
                                accept="image/*"
                                capture="environment"
                                onChange={handleFileSelect}
                                className="hidden"
                            />

                            {/* AI Scan Button */}
                            <AnimatePresence>
                                {receiptFile && (
                                    <motion.button
                                        type="button"
                                        initial={{ opacity: 0, scale: 0.97 }}
                                        animate={{ opacity: 1, scale: 1 }}
                                        exit={{ opacity: 0, scale: 0.97 }}
                                        onClick={handleScanReceipt}
                                        disabled={isScanning || submitting}
                                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gradient-to-r from-violet-600/20 to-purple-600/20 hover:from-violet-600/30 hover:to-purple-600/30 border border-violet-500/30 hover:border-violet-400/50 rounded-xl text-violet-200 hover:text-white transition-all text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed"
                                    >
                                        {isScanning ? (
                                            <>
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                                <span>{receiptFile?.type === 'application/pdf' ? 'PDF işleniyor...' : 'Yapay Zeka İnceliyor...'}</span>
                                            </>
                                        ) : (
                                            <>
                                                <Sparkles className="w-4 h-4" />
                                                <span>✨ Fişi Tara (AI)</span>
                                            </>
                                        )}
                                    </motion.button>
                                )}
                            </AnimatePresence>

                            {/* Scan error */}
                            <AnimatePresence>
                                {scanError && (
                                    <motion.div
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        className="flex items-start gap-2 px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg"
                                    >
                                        <AlertTriangle className="w-3.5 h-3.5 text-danger shrink-0 mt-0.5" />
                                        <p className="text-danger text-xs">{scanError}</p>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>

                        {/* Form Error */}
                        {error && (
                            <p className="text-danger text-sm bg-danger/10 border border-danger/20 rounded-lg px-3 py-2">
                                {error}
                            </p>
                        )}

                        {/* Actions */}
                        <div className="flex gap-3 pt-1">
                            <button
                                type="button"
                                onClick={onClose}
                                className="flex-1 py-2.5 bg-background-elevated hover:bg-background-tertiary text-text-secondary hover:text-white rounded-xl border border-white/5 transition-all text-sm font-medium"
                            >
                                İptal
                            </button>
                            <button
                                type="submit"
                                disabled={submitting}
                                className="flex-1 py-2.5 bg-primary hover:bg-primary-dark text-white rounded-xl shadow-lg shadow-primary/25 hover:shadow-primary/40 transition-all text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                                {submitting ? 'Kaydediliyor...' : isEdit ? 'Güncelle' : 'Kaydet'}
                            </button>
                        </div>
                    </form>
                </motion.div>
            </motion.div>

            {/* Receipt Viewer Modal */}
            <ReceiptViewer
                url={viewingReceipt}
                onClose={() => setViewingReceipt(null)}
            />
        </Portal>
    )
}
