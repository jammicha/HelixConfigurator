// frontend/src/components/UpdateBanner.tsx
import { useEffect, useState } from 'react'

type V = { current: string; latest: string | null; updateAvailable: boolean }

export function UpdateBanner() {
  const [v, setV] = useState<V | null>(null)
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    fetch('/api/version').then(r => r.json()).then(setV).catch(() => {})
  }, [])
  if (!v?.updateAvailable || dismissed) return null
  return (
    <div className="flex items-center justify-between bg-[#3759d8] px-4 py-2 text-sm text-white">
      <span>Update available: v{v.latest} (you have v{v.current}). Re-run your install command to update.</span>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss update banner"
        className="cursor-pointer rounded border border-white bg-transparent px-2.5 py-0.5 text-white hover:bg-white/10"
      >
        Dismiss
      </button>
    </div>
  )
}
