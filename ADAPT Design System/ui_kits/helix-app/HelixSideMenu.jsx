/* Left side menu — collapsible nav grouped by area. */

function HelixSideMenu({ active, onSelect }) {
  const sections = [
    { title: 'Operate', items: [
      { label: 'Dashboard',  icon: 'dashboard' },
      { label: 'Incidents',  icon: 'alert-fill', count: 27 },
      { label: 'Changes',    icon: 'sync',       count: 4 },
      { label: 'Problems',   icon: 'warning',    count: 2 },
      { label: 'Tasks',      icon: 'check-list' },
    ]},
    { title: 'Knowledge', items: [
      { label: 'Articles',   icon: 'document' },
      { label: 'Runbooks',   icon: 'book' },
    ]},
    { title: 'Configure', items: [
      { label: 'Services',   icon: 'puzzle' },
      { label: 'Assets',     icon: 'computer' },
      { label: 'Workflows',  icon: 'flow' },
    ]},
  ];
  return (
    <aside className="hx-side">
      <div className="hx-side__inner">
        {sections.map(sec => (
          <div key={sec.title} className="hx-side__group">
            <div className="hx-side__group-title">{sec.title}</div>
            {sec.items.map(it => (
              <a key={it.label}
                 className={`hx-side__item ${active === it.label ? 'is-active' : ''}`}
                 onClick={() => onSelect(it.label)}>
                <i className={`d-icon dpl-icon-${it.icon}`}></i>
                <span className="hx-side__item-label">{it.label}</span>
                {it.count != null && <span className="hx-side__count">{it.count}</span>}
              </a>
            ))}
          </div>
        ))}
      </div>
      <div className="hx-side__footer">
        <a className="hx-side__item">
          <i className="d-icon d-icon-gear"></i>
          <span className="hx-side__item-label">Settings</span>
        </a>
      </div>
    </aside>
  );
}
