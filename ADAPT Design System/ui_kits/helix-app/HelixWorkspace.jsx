/* Workspace — page header, KPI cards, incident table, activity feed. */

function HelixWorkspace({ active, onNewIncident }) {
  return (
    <div className="hx-work">
      <PageHeader active={active} onNewIncident={onNewIncident} />
      <KPIRow/>
      <div className="hx-work__split">
        <IncidentTable/>
        <ActivityFeed/>
      </div>
    </div>
  );
}

function PageHeader({ active, onNewIncident }) {
  return (
    <div className="hx-page-header">
      <div>
        <div className="hx-breadcrumb">
          <a>Operate</a>
          <i className="d-icon d-icon-arrow_right"></i>
          <a>{active}</a>
        </div>
        <h1 className="hx-page-title">{active}</h1>
        <p className="hx-page-sub">Open and assigned incidents across all groups.</p>
      </div>
      <div className="hx-page-actions">
        <button className="btn btn-secondary"><i className="d-icon d-icon-filter"></i> Filter</button>
        <button className="btn btn-secondary"><i className="d-icon d-icon-download"></i> Export</button>
        <button className="btn btn-primary" onClick={onNewIncident}>
          <i className="d-icon d-icon-plus"></i> New incident
        </button>
      </div>
    </div>
  );
}

function KPIRow() {
  const cards = [
    { label: 'Open',        value: 142, delta: '+8',   tone: 'info'    },
    { label: 'Critical',    value: 9,   delta: '+2',   tone: 'danger'  },
    { label: 'Breached SLA',value: 3,   delta: '-1',   tone: 'warning' },
    { label: 'Resolved (24h)', value: 87, delta: '+12',tone: 'success' },
  ];
  return (
    <div className="hx-kpi-row">
      {cards.map(c => (
        <div key={c.label} className={`hx-kpi hx-kpi--${c.tone} shadow-1`}>
          <div className="hx-kpi__label">{c.label}</div>
          <div className="hx-kpi__value">{c.value}</div>
          <div className="hx-kpi__delta">{c.delta} vs. yesterday</div>
        </div>
      ))}
    </div>
  );
}

function IncidentTable() {
  const rows = [
    { id:'INC-10042', title:'Database replication lag — APAC region', sev:'Critical', status:'In Progress', assignee:'Priya Shah', age:'12m' },
    { id:'INC-10041', title:'Helix Portal: SSO redirect loop for Okta tenants', sev:'High', status:'Triage', assignee:'Marcus Wei', age:'34m' },
    { id:'INC-10040', title:'Email notifications delayed > 5 min',           sev:'High', status:'In Progress', assignee:'Adrian Vasquez', age:'1h' },
    { id:'INC-10039', title:'Knowledge search returns 0 results for tenant qa-7', sev:'Medium', status:'Triage', assignee:'—', age:'1h 22m' },
    { id:'INC-10038', title:'Mobile app crashes on iOS 18 when opening attachments', sev:'Medium', status:'Open', assignee:'Lin Zhao', age:'2h' },
    { id:'INC-10037', title:'Workflow engine retry storm on rule#118',        sev:'Low',    status:'Resolved',   assignee:'Hannah Ortiz', age:'4h' },
  ];
  const sevTone = { Critical:'danger', High:'warning', Medium:'info', Low:'gray' };
  const statusTone = { 'In Progress':'info', 'Triage':'warning', 'Open':'gray', 'Resolved':'success' };

  return (
    <section className="card hx-table-wrap">
      <div className="hx-table-head">
        <div>
          <h3 className="hx-table-title">Active incidents</h3>
          <p className="hx-table-sub">{rows.length} of 142 · sorted by age</p>
        </div>
        <div className="hx-tabs">
          <button className="hx-tab is-active">All</button>
          <button className="hx-tab">Mine</button>
          <button className="hx-tab">Watching</button>
        </div>
      </div>
      <table className="hx-table">
        <thead>
          <tr>
            <th style={{width:'90px'}}>ID</th>
            <th>Title</th>
            <th style={{width:'90px'}}>Severity</th>
            <th style={{width:'120px'}}>Status</th>
            <th style={{width:'130px'}}>Assignee</th>
            <th style={{width:'70px'}}>Age</th>
            <th style={{width:'40px'}}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td className="hx-table__id">{r.id}</td>
              <td className="hx-table__title">{r.title}</td>
              <td><span className={`badge badge-${sevTone[r.sev]}`}>{r.sev}</span></td>
              <td><span className={`badge badge-${statusTone[r.status]}`}>{r.status}</span></td>
              <td className="hx-table__assignee">
                {r.assignee !== '—' && <span className="hx-assignee-dot">{r.assignee.split(' ').map(s=>s[0]).join('')}</span>}
                {r.assignee}
              </td>
              <td className="hx-table__age">{r.age}</td>
              <td><button className="hx-row-more" aria-label="More"><i className="d-icon d-icon-list"></i></button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ActivityFeed() {
  const items = [
    { tone:'helix', icon:'helix-gpt', title:'HelixGPT suggested a runbook',
      body:'For INC-10042, summary indicates a known APAC replica failover — see Runbook RB-219.', time:'2m ago' },
    { tone:'info',  icon:'comment', title:'Marcus Wei commented on INC-10041',
      body:"Confirmed — affects only Okta tenants on the EU region. Working with the auth team.", time:'14m ago' },
    { tone:'warn',  icon:'warning', title:'SLA breach in 8 minutes',
      body:'INC-10038 — response SLA expires at 14:42 UTC.', time:'21m ago' },
    { tone:'ok',    icon:'check-circle-fill', title:'INC-10037 resolved by Hannah Ortiz',
      body:'Root cause: mis-configured retry-policy on rule#118. PR merged.', time:'48m ago' },
    { tone:'info',  icon:'user-add', title:'Priya Shah was assigned to INC-10042',
      body:'Auto-routed by skill-based assignment.', time:'1h ago' },
  ];
  return (
    <aside className="card hx-activity">
      <div className="hx-activity__head">
        <h3>Activity</h3>
        <a className="hx-activity__link">View all</a>
      </div>
      <ul className="hx-activity__list">
        {items.map((it, i) => (
          <li key={i} className={`hx-activity__item hx-activity__item--${it.tone}`}>
            <div className="hx-activity__icon"><i className={`d-icon dpl-icon-${it.icon}`}></i></div>
            <div className="hx-activity__body">
              <div className="hx-activity__title">{it.title}</div>
              <div className="hx-activity__text">{it.body}</div>
              <div className="hx-activity__time">{it.time}</div>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
