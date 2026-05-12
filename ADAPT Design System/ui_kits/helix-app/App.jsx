/* Helix App Shell — composition.
   Renders the in-product look BMC Helix wears: top bar with global tools,
   left side menu, dashboard with cards / table / activity, modal, and the
   HelixGPT slide-in panel. */

const { useState } = React;

ReactDOM.createRoot(document.getElementById('root')).render(<HelixApp/>);

function HelixApp() {
  const [helixOpen, setHelixOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [activeNav, setActiveNav] = useState('Incidents');

  return (
    <div className="helix-app" data-screen-label="Helix App Shell">
      <HelixTopBar onHelixGPT={() => setHelixOpen(true)} />
      <div className="helix-body">
        <HelixSideMenu active={activeNav} onSelect={setActiveNav} />
        <main className="helix-main">
          <HelixWorkspace active={activeNav} onNewIncident={() => setModalOpen(true)} />
        </main>
      </div>
      {helixOpen && <HelixGPTPanel onClose={() => setHelixOpen(false)} />}
      {modalOpen && <NewIncidentModal onClose={() => setModalOpen(false)} />}
    </div>
  );
}
