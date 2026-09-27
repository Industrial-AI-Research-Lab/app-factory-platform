import { useState } from 'react'

/** Uncontrolled: defaultTab only. Controlled: pass activeTab + onTabChange. */
export default function TabNavigation({ tabs, defaultTab = 0, activeTab: controlledTab, onTabChange }) {
  const [internalTab, setInternalTab] = useState(defaultTab)
  const isControlled = controlledTab !== undefined && controlledTab !== null
  const activeTab = isControlled ? controlledTab : internalTab

  const selectTab = (index) => {
    if (isControlled) onTabChange?.(index)
    else setInternalTab(index)
  }

  return (
    <div className="w-full">
      {/* Tab Headers - Compact */}
      <div className="flex border-b border-slate-700 mb-4">
        {tabs.map((tab, index) => (
          <button
            key={index}
            onClick={() => selectTab(index)}
            className={`px-4 py-2 font-medium text-sm transition-colors relative ${
              activeTab === index
                ? 'text-blue-400 border-b-2 border-blue-400'
                : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            <div className="flex items-center gap-2">
              {tab.icon && <span className="w-4 h-4">{tab.icon}</span>}
              <span>{tab.label}</span>
              {tab.badge && (
                <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-slate-700 text-slate-300 rounded-full">
                  {tab.badge}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="tab-content">
        {tabs[activeTab]?.content}
      </div>
    </div>
  )
}
