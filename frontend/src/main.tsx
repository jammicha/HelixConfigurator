import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { AiopsPage } from './components/AiopsPage'
import { OtelDataPage } from './components/OtelDataPage'
import { StepZero } from './components/step-zero/StepZero'
import './index.css'

const path = window.location.pathname
const isAiops = path.startsWith('/aiops')
const isOtelData = path.startsWith('/otel-data')
const isStepZero = path.startsWith('/step-zero')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isAiops ? <AiopsPage /> :
     isOtelData ? <OtelDataPage /> :
     isStepZero ? <StepZero /> :
     <App />}
  </React.StrictMode>,
)
