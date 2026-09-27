const STEPS = [
  { id: 1, label: 'ZIP' },
  { id: 2, label: 'Dockerfile' },
  { id: 3, label: 'Build' },
  { id: 4, label: 'Connect' },
]

export default function McpZipWizardStepper({ currentStep }) {
  return (
    <nav aria-label="Import progress" className="flex items-center gap-1 sm:gap-2 mb-4">
      {STEPS.map((step, idx) => {
        const done = currentStep > step.id
        const active = currentStep === step.id
        return (
          <div key={step.id} className="flex items-center gap-1 sm:gap-2 min-w-0 flex-1 last:flex-none">
            <div
              className={`flex items-center gap-1.5 min-w-0 ${
                active ? 'text-purple-300' : done ? 'text-emerald-400/90' : 'text-slate-500'
              }`}
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold border ${
                  active
                    ? 'border-purple-500 bg-purple-950/50 text-purple-200'
                    : done
                      ? 'border-emerald-600/60 bg-emerald-950/30 text-emerald-200'
                      : 'border-slate-600 bg-slate-800 text-slate-400'
                }`}
              >
                {done ? 'OK' : step.id}
              </span>
              <span className="text-xs font-medium truncate hidden sm:inline">{step.label}</span>
            </div>
            {idx < STEPS.length - 1 && (
              <div
                className={`h-px flex-1 min-w-[8px] ${
                  currentStep > step.id ? 'bg-emerald-700/50' : 'bg-slate-600'
                }`}
              />
            )}
          </div>
        )
      })}
    </nav>
  )
}
