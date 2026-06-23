import './TopBar.css';

export function TopBar() {
  return (
    <div className="top-bar">
      <div className="top-bar__brand">
        <div className="top-bar__logo">
          <span />
          <span />
          <span />
        </div>
        <span className="top-bar__name">Pulse</span>
        <span className="top-bar__badge">REAL-TIME</span>
      </div>
      <div className="top-bar__right">
        <div className="top-bar__status">
          <span className="top-bar__status-dot" />
          Markets open
        </div>
        <div className="top-bar__avatar">AC</div>
      </div>
    </div>
  );
}
