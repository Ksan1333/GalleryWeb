import { useState } from "react";

import { releaseNotes } from "../releaseNotes";
import { Icon } from "./Icon";

export function ReleaseHistory() {
  const [openVersions, setOpenVersions] = useState<Set<string>>(
    () => new Set(releaseNotes[0] ? [releaseNotes[0].version] : []),
  );

  const toggle = (version: string) => {
    setOpenVersions((current) => {
      const next = new Set(current);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  };

  return (
    <div className="release-history-list">
      {releaseNotes.map((release, index) => {
        const open = openVersions.has(release.version);
        return (
          <article className={open ? "is-open" : ""} key={release.version}>
            <button
              type="button"
              className="release-history-summary"
              aria-expanded={open}
              onClick={() => toggle(release.version)}
            >
              <span>
                <em>{index === 0 ? "最新版" : release.date}</em>
                <strong>バージョン {release.version}</strong>
                <small>{release.title}</small>
              </span>
              <Icon name={open ? "minus" : "chevronRight"} />
            </button>
            {open && (
              <ul>
                {release.changes.map((change) => <li key={change}>{change}</li>)}
              </ul>
            )}
          </article>
        );
      })}
    </div>
  );
}

export default ReleaseHistory;
