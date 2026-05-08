import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { AiopsPage } from './components/AiopsPage'
import { OtelDataPage } from './components/OtelDataPage'
import './index.css'

const path = window.location.pathname
const isAiops = path.startsWith('/aiops')
const isOtelData = path.startsWith('/otel-data')

const goHome = () => { window.location.href = '/' }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isAiops ? <AiopsPage /> : isOtelData ? <OtelDataPage onExit={goHome} /> : <App />}
  </React.StrictMode>,
)
