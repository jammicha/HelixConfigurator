/* New incident modal — standard form pattern. */

function NewIncidentModal({ onClose }) {
  return (
    <div className="hx-modal-mask" onClick={onClose}>
      <div className="hx-modal" onClick={e => e.stopPropagation()} role="dialog">
        <header className="hx-modal__head">
          <h3>New incident</h3>
          <button className="hx-modal__close" onClick={onClose} aria-label="Close">
            <i className="d-icon d-icon-cross"></i>
          </button>
        </header>
        <div className="hx-modal__body">
          <div className="form-group">
            <label className="form-label">Title <span className="form-required">*</span></label>
            <input type="text" className="form-input" defaultValue="Database replication lag — APAC region"/>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Severity</label>
              <select className="form-select" defaultValue="Critical">
                <option>Critical</option><option>High</option><option>Medium</option><option>Low</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Service</label>
              <select className="form-select"><option>Helix Platform</option><option>BMC Discovery</option></select>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Assignment group</label>
              <select className="form-select"><option>Database Operations</option></select>
            </div>
            <div className="form-group">
              <label className="form-label">Assignee</label>
              <select className="form-select"><option>Priya Shah</option><option>Marcus Wei</option></select>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Description</label>
            <textarea className="form-input" rows="4" defaultValue="Replication lag against apac-replica-2 increased from < 1s to ~7 minutes between 14:08–14:14 UTC. Customer dashboards reporting stale data."></textarea>
          </div>
          <div className="alert alert-helix">
            <i className="d-icon d-icon-helix_gpt"></i>
            <div>
              <strong>HelixGPT suggestion:</strong> This looks similar to 12 prior incidents on apac-replica-2.
              Apply <a>Runbook RB-219</a>?
            </div>
          </div>
        </div>
        <footer className="hx-modal__foot">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary">Create incident</button>
        </footer>
      </div>
    </div>
  );
}
