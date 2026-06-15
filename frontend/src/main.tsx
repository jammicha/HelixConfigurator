import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { OtelDataPage } from './components/OtelDataPage'
import { StepZero } from './components/step-zero/StepZero'
import { DashboardMockup } from './components/dashboard/DashboardMockup'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'

const path = window.location.pathname
const isOtelData = path.startsWith('/otel-data')
const isStepZero = path.startsWith('/step-zero')
const isDashboardMockup = path.startsWith('/dashboard-mockup')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isOtelData ? <OtelDataPage /> :
       isStepZero ? <StepZero /> :
       isDashboardMockup ? <DashboardMockup /> :
       <App />}
    </ErrorBoundary>
  </React.StrictMode>,
)
