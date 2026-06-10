// frontend/src/components/UpdateBanner.tsx
import { useEffect, useRef, useState } from 'react'

type V = { current: string; latest: string | null; updateAvailable: boolean }
type Capability = { supported: boolean; mode: string; hint?: string }
type Phase =
  | 'idle'          // banner showing, no update running
  | 'working'       // start posted; polling /api/update/status
  | 'restarting'    // apply posted; waiting for the new version to come back
  | 'done'          // new version answered — about to reload
  | 'error'

export function UpdateBanner() {
  const [v, setV] = useState<V | null>(null)
  const [cap, setCap] = useState<Capability | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [detail, setDetail] = useState('')
  const timersRef = useRef<number[]>([])

  useEffect(() => {
    fetch('/api/version').then(r => r.json()).then(setV).catch(() => {})
    fetch('/api/update/capability').then(r => (r.ok ? r.json() : null)).then(setCap).catch(() => {})
    const timers = timersRef.current
    return () => { timers.forEach(t => window.clearTimeout(t)) }
  }, [])

  if (!v?.updateAvailable || dismissed) return null

  const later = (fn: () => void, ms: number) => { timersRef.current.push(window.setTimeout(fn, ms)) }

  const PHASE_LABEL: Record<string, string> = {
    starting: 'Starting…',
    downloading: `Downloading v${v.latest}…`,
    extracting: 'Unpacking…',
    validating: 'Verifying the package…',
    ready: 'Ready — restarting…',
  }

  // After apply, the server goes away and comes back as the new version.
  // Poll /api/version until `current` changes (or give up after ~90s).
  const waitForNewVersion = (deadline: number) => {
    if (Date.now() > deadline) {
      setPhase('error')
      setDetail('The restart is taking too long — check the terminal where the configurator runs.')
      return
    }
    fetch('/api/version')
      .then(r => r.json())
      .then((nv: V) => {
        if (nv.current && nv.current !== v.current) {
          setPhase('done')
          setDetail(`Updated to v${nv.current} — reloading…`)
          later(() => window.location.reload(), 1200) // pick up the new frontend bundle
        } else {
          later(() => waitForNewVersion(deadline), 1500)
        }
      })
      .catch(() => later(() => waitForNewVersion(deadline), 1500))
  }

  const pollUntilReady = () => {
    fetch('/api/update/status')
      .then(r => r.json())
      .then((s: { phase: string; error: string | null }) => {
        if (s.error) {
          setPhase('error')
          setDetail(s.error)
          return
        }
        setDetail(PHASE_LABEL[s.phase] || `${s.phase}…`)
        if (s.phase === 'ready') {
          fetch('/api/update/apply', { method: 'POST' })
            .then(() => {
              setPhase('restarting')
              setDetail('Restarting with the new version…')
              later(() => waitForNewVersion(Date.now() + 90_000), 2500)
            })
            .catch(() => { setPhase('error'); setDetail('Could not apply the update.') })
        } else {
          later(pollUntilReady, 1000)
        }
      })
      .catch(() => later(pollUntilReady, 1500))
  }

  const startUpdate = () => {
    setPhase('working')
    setDetail('Starting…')
    fetch('/api/update/start', { method: 'POST' })
      .then(async r => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.error || `HTTP ${r.status}`)
        }
        later(pollUntilReady, 800)
      })
      .catch(e => { setPhase('error'); setDetail(String(e.message || e)) })
  }

  const tone = phase === 'done' ? 'bg-[#1f7a3d]' : phase === 'error' ? 'bg-[#8a2a2a]' : 'bg-[#3759d8]'

  return (
    <div className={`flex items-center justify-between gap-3 px-4 py-2 text-sm text-white ${tone}`}>
      {phase === 'idle' && (
        <span>
          Update available: v{v.latest} (you have v{v.current}).
          {cap?.supported ? '' : ` ${cap?.hint || 'Re-run your install command to update.'}`}
        </span>
      )}
      {phase !== 'idle' && <span>{phase === 'error' ? `Update failed: ${detail}` : detail}</span>}

      <div className="flex items-center gap-2 flex-shrink-0">
        {phase === 'idle' && cap?.supported && (
          <button
            onClick={startUpdate}
            className="cursor-pointer rounded border border-white bg-white/15 px-2.5 py-0.5 font-semibold text-white hover:bg-white/25"
          >
            Update now
          </button>
        )}
        {phase === 'error' && (
          <button
            onClick={startUpdate}
            className="cursor-pointer rounded border border-white bg-transparent px-2.5 py-0.5 text-white hover:bg-white/10"
          >
            Retry
          </button>
        )}
        {(phase === 'idle' || phase === 'error') && (
          <button
            onClick={() => setDismissed(true)}
            aria-label="Dismiss update banner"
            className="cursor-pointer rounded border border-white bg-transparent px-2.5 py-0.5 text-white hover:bg-white/10"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  )
}
