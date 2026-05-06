import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { AiopsPage } from './components/AiopsPage'
import './index.css'

const isAiops = window.location.pathname.startsWith('/aiops')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isAiops ? <AiopsPage /> : <App />}
  </React.StrictMode>,
)
