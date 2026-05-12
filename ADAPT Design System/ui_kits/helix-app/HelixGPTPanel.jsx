/* HelixGPT slide-in panel — the GenAI surface.
   Uses the brand --helix-gpt-color (#f86e00) as the *one* warm accent. */

function HelixGPTPanel({ onClose }) {
  const [input, setInput] = React.useState('');
  const conversation = [
    { from:'user', text:'Summarize INC-10042 and recommend next steps.' },
    { from:'gpt',  text:'INC-10042 is a critical APAC database replication lag (~7 min behind primary). The pattern matches RB-219 — failover playbook for the apac-replica-2 cluster. Recommended next steps:',
      bullets:[
        'Page the on-call DBA for apac-replica-2 (escalation tier 2).',
        'Trigger read-only failover to apac-replica-3 to relieve pressure.',
        'Snapshot binlog before recovery for post-mortem.',
      ],
      footer:'Confidence: high · Based on 12 similar incidents.' },
  ];
  return (
    <div className="hx-helix" role="dialog" aria-label="HelixGPT">
      <div className="hx-helix__head">
        <div className="hx-helix__brand">
          <i className="d-icon d-icon-helix_gpt"></i>
          <span>HelixGPT</span>
          <span className="hx-helix__pill">Beta</span>
        </div>
        <button className="hx-helix__close" onClick={onClose} aria-label="Close">
          <i className="d-icon d-icon-cross"></i>
        </button>
      </div>
      <div className="hx-helix__chips">
        <span>Context: INC-10042</span>
        <span>Knowledge base</span>
        <span>Runbooks</span>
      </div>
      <div className="hx-helix__chat">
        {conversation.map((m, i) => (
          <div key={i} className={`hx-msg hx-msg--${m.from}`}>
            {m.from === 'gpt' && (
              <div className="hx-msg__avatar"><i className="d-icon d-icon-helix_gpt"></i></div>
            )}
            <div className="hx-msg__bubble">
              <p>{m.text}</p>
              {m.bullets && (
                <ol>{m.bullets.map((b,j) => <li key={j}>{b}</li>)}</ol>
              )}
              {m.footer && <div className="hx-msg__footer">{m.footer}</div>}
              {m.from === 'gpt' && (
                <div className="hx-msg__actions">
                  <button><i className="d-icon d-icon-thumbs_up"></i></button>
                  <button><i className="d-icon d-icon-thumbs_down"></i></button>
                  <button><i className="d-icon d-icon-files_copy_o"></i> Copy</button>
                  <button><i className="d-icon d-icon-refresh"></i> Regenerate</button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="hx-helix__suggestions">
        <button>Draft customer comms</button>
        <button>Find similar incidents</button>
        <button>Open RB-219</button>
      </div>
      <form className="hx-helix__composer" onSubmit={e => { e.preventDefault(); setInput(''); }}>
        <input
          type="text"
          placeholder="Ask HelixGPT about this incident…"
          value={input}
          onChange={e => setInput(e.target.value)}
        />
        <button type="submit" className="btn btn-primary btn-sm" aria-label="Send">
          <i className="d-icon d-icon-arrow_up"></i>
        </button>
      </form>
      <div className="hx-helix__disclaimer">
        AI-generated content can be inaccurate. Verify before action.
      </div>
    </div>
  );
}
