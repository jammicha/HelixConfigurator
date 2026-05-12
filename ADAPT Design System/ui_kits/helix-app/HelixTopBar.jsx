/* Top bar — BMC Helix product navigation.
   Aligned with other Helix products: light header, brand lock-up on left,
   tab nav in centre, lightweight tools on right. */

const { useState: useTopState } = React;

function HelixTopBar({ onHelixGPT }) {
  const tabs = ['Overview', 'Services', 'Situations', 'Predictions', 'Dashboards', 'Configurations'];
  const [active, setActive] = useTopState('Overview');
  return (
    <header className="hx-topbar">
      <div className="hx-topbar__brand-lockup">
        <img src={(window.__resources && window.__resources.bmcHelixLogo) || '../../assets/bmc-helix-logo.svg'}
             alt="bmc helix" className="hx-topbar__logo"/>
        <span className="hx-topbar__divider" aria-hidden="true"></span>
        <span className="hx-topbar__product">Service Management</span>
      </div>

      <nav className="hx-topbar__tabs" aria-label="Primary">
        {tabs.map(t => (
          <a key={t}
             className={`hx-tab ${active === t ? 'is-active' : ''}`}
             onClick={() => setActive(t)}>
            {t}
          </a>
        ))}
      </nav>

      <div className="hx-topbar__right">
        <button className="hx-topbar__icon-btn hx-topbar__icon-btn--caret" aria-label="App switcher" title="Apps">
          <i className="d-icon d-icon-cubes_o"></i>
          <i className="d-icon d-icon-arrow_down hx-topbar__icon-caret"></i>
        </button>
        <button className="hx-topbar__icon-btn" aria-label="Help" title="Help">
          <i className="d-icon d-icon-question_circle_o"></i>
        </button>
        <button className="hx-topbar__user" aria-label="Adrian Vasquez">
          <span className="hx-avatar">A</span>
          <i className="d-icon d-icon-arrow_down hx-topbar__user-caret"></i>
        </button>
        {/* HelixGPT entry kept as a hidden trigger; opens via keyboard / programmatic */}
        <button className="hx-topbar__gpt-trigger" onClick={onHelixGPT} aria-label="Open HelixGPT">
          <i className="d-icon d-icon-helix_gpt"></i>
        </button>
      </div>
    </header>
  );
}
