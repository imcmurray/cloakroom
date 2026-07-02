import type { ReactNode } from 'react';

export function Pane({ label, sub, action, children }: {
  label: string; sub: string; action?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="pane">
      <div className="pane-head">
        <div>
          <div className="pane-label">{label}</div>
          <div className="pane-sub">{sub}</div>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
