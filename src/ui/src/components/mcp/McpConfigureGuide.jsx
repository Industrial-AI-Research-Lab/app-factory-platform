import { FileJson, Search } from 'lucide-react'

export default function McpConfigureGuide() {
  return (
    <div className="grid gap-3 md:grid-cols-2 mb-5">
      <div className="rounded-lg border border-slate-600 bg-slate-800/80 p-4">
        <div className="flex items-center gap-2 mb-2">
          <Search className="w-4 h-4 text-blue-400 shrink-0" />
          <h3 className="text-sm font-semibold text-slate-100">Server discovery (step by step)</h3>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">
          For <strong className="text-slate-300">one new MCP server</strong>: enter connection settings, run
          {' '}<strong className="text-slate-300">Discover Tools</strong>, select tools, then{' '}
          <strong className="text-slate-300">Import Selected</strong>. AppFactory saves tools in the database and
          updates tenant mcp.json. Use the small JSON box here only to <strong className="text-slate-300">fill the form</strong>
          {' '}(paste from your local Cursor file) — it does not save to the tenant by itself.
        </p>
      </div>
      <div className="rounded-lg border border-slate-600 bg-slate-800/80 p-4">
        <div className="flex items-center gap-2 mb-2">
          <FileJson className="w-4 h-4 text-amber-300 shrink-0" />
          <h3 className="text-sm font-semibold text-slate-100">Tenant mcp.json (bulk sync)</h3>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">
          The editor below is the <strong className="text-slate-300">saved tenant configuration</strong> (like Cursor&apos;s
          mcp.json). <strong className="text-slate-300">Save tenant JSON</strong> syncs Mongo: new servers are discovered and
          imported; existing servers are left as-is (no rediscovery). Only edit{' '}
          <code className="text-slate-300">tools</code> / <code className="text-slate-300">disabledTools</code> when you
          mean to enable or disable tools, or to remove a tool from the list. Renaming a tool (swap one name for
          another in the same save) is not supported — remove the old name and Save, then add via Discover.
          Invalid tool names are normalized automatically.
        </p>
      </div>
    </div>
  )
}
