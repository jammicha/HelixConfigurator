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
    <div style={{ background: '#3759d8', color: '#fff', padding: '8px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span>Update available: v{v.latest} (you have v{v.current}). Re-run your install command to update.</span>
      <button onClick={() => setDismissed(true)} style={{ background: 'transparent', border: '1px solid #fff', color: '#fff', borderRadius: 6, padding: '2px 10px', cursor: 'pointer' }}>Dismiss</button>
    </div>
  )
}
