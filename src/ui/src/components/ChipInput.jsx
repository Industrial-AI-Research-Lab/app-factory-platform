import { useState, useRef } from 'react'
import { X } from 'lucide-react'

/**
 * ChipInput — displays selected values as removable chips, with a text input
 * for adding new values. Supports clicking available suggestions and Ctrl+V paste.
 *
 * Props:
 *   values: string[]           — current selected values
 *   onChange: (string[]) => void
 *   suggestions: string[]      — available items to show as clickable chips
 *   placeholder: string
 *   disabled: boolean
 */
export default function ChipInput({ values = [], onChange, suggestions = [], placeholder = '', disabled = false, chipClassName }) {
  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef(null)

  const addValues = (raw) => {
    const items = raw
      .split(/[,\n]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => !values.includes(s))
    if (items.length > 0) {
      onChange([...values, ...items])
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      if (inputValue.trim()) {
        addValues(inputValue)
        setInputValue('')
      }
    } else if (e.key === 'Backspace' && !inputValue && values.length > 0) {
      onChange(values.slice(0, -1))
    }
  }

  const handlePaste = (e) => {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text')
    addValues(pasted)
    setInputValue('')
  }

  const removeValue = (val) => {
    onChange(values.filter(v => v !== val))
  }

  const normalizedSuggestions = suggestions
    .map((suggestion) => {
      if (typeof suggestion === 'string') {
        return { value: suggestion, label: suggestion }
      }
      const value = String(suggestion?.value || '').trim()
      return { value, label: String(suggestion?.label || value) }
    })
    .filter(({ value }) => Boolean(value))

  const addSuggestion = (val) => {
    if (!values.includes(val)) {
      onChange([...values, val])
    }
    inputRef.current?.focus()
  }

  // Suggestions not yet selected
  const availableSuggestions = normalizedSuggestions.filter(({ value }) => !values.includes(value))

  return (
    <div className={disabled ? 'opacity-50 pointer-events-none' : ''}>
      {/* Selected chips + input */}
      <div
        className="flex flex-wrap items-center gap-1.5 min-h-[34px] px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm focus-within:ring-1 focus-within:ring-blue-500 cursor-text"
        onClick={() => inputRef.current?.focus()}
      >
        {values.map(val => {
          const extraClass = chipClassName ? chipClassName(val) : ''
          return (
          <span
            key={val}
            className={`inline-flex items-center gap-1 px-2 py-0.5 border rounded text-xs ${extraClass || 'bg-blue-600/40 border-blue-500/50 text-blue-200'}`}
          >
            {val}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeValue(val) }}
              className="hover:text-red-300 transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        )})}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => {
            if (inputValue.trim()) {
              addValues(inputValue)
              setInputValue('')
            }
          }}
          disabled={disabled}
          placeholder={values.length === 0 ? placeholder : ''}
          className="flex-1 min-w-[80px] bg-transparent outline-none text-sm text-slate-200 placeholder:text-slate-500"
        />
      </div>

      {/* Available suggestions as clickable chips */}
      {availableSuggestions.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {availableSuggestions.map(s => (
            <button
              key={s.value}
              type="button"
              onClick={() => addSuggestion(s.value)}
              className="px-1.5 py-0.5 text-[10px] bg-slate-700/60 border border-slate-600/50 rounded text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors"
            >
              + {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
