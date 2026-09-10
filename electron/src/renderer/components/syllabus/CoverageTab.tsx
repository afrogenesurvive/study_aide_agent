import type { CoverageReport } from "../../../shared/syllabus-types";
import { TOPIC_STATUS_LABELS, TOPIC_STATUSES } from "../../../shared/syllabus-types";

/**
 * Coverage analytics.
 *
 * Computed from topic status and valence alone, so it is useful from the moment a
 * syllabus is imported. Retention curves and FSRS-based exam projections arrive
 * with the review system in phase 2.
 */
export function CoverageTab({ coverage }: { coverage: CoverageReport | null }) {
  if (!coverage) {
    return <p className="muted">Import a syllabus to see coverage.</p>;
  }

  return (
    <div className="coverage-tab">
      <div className="stat-grid">
        <div className="stat">
          <span className="stat__value">{coverage.introducedPct}%</span>
          <span className="stat__label">Covered</span>
        </div>
        <div className="stat">
          <span className="stat__value">{coverage.masteredPct}%</span>
          <span className="stat__label">Mastered</span>
        </div>
        <div className="stat">
          <span className="stat__value">{coverage.remainingEstHours}h</span>
          <span className="stat__label">Est. work left</span>
        </div>
        <div className="stat">
          <span className="stat__value">
            {coverage.daysToExam === null ? "—" : `${coverage.daysToExam} d`}
          </span>
          <span className="stat__label">To exam</span>
        </div>
      </div>

      {coverage.hoursPerWeekNeeded !== null ? (
        <div className="notice notice--ok">
          <strong>{coverage.hoursPerWeekNeeded} h/week</strong>
          <span>
            to finish {coverage.remainingEstHours} h of remaining material with {coverage.weeksToExam} weeks left.
          </span>
        </div>
      ) : (
        <div className="notice notice--warn">
          <strong>No exam date set</strong>
          <span>Add one to the syllabus to project the pace you need.</span>
        </div>
      )}

      <fieldset className="fieldset">
        <legend>Progress</legend>
        <table className="table">
          <tbody>
            {TOPIC_STATUSES.map((status) => (
              <tr key={status}>
                <td>
                  <span className={`status-chip status-chip--${status}`}>
                    {TOPIC_STATUS_LABELS[status]}
                  </span>
                </td>
                <td className="table__number">{coverage.byStatus[status]}</td>
                <td className="table__bar">
                  <div className="bar">
                    <div
                      className={`bar__fill bar__fill--${status}`}
                      style={{ width: `${coverage.total ? (coverage.byStatus[status] / coverage.total) * 100 : 0}%` }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Valence</legend>
        <div className="valence-summary">
          <span className="valence-stat valence-stat--red">{coverage.byValence.red} struggling</span>
          <span className="valence-stat valence-stat--yellow">{coverage.byValence.yellow} curious</span>
          <span className="valence-stat valence-stat--green">{coverage.byValence.green} mastered</span>
          <span className="valence-stat">{coverage.byValence.untagged} untagged</span>
        </div>
      </fieldset>

      <fieldset className="fieldset">
        <legend>By section</legend>
        <table className="table">
          <thead>
            <tr>
              <th>Section</th>
              <th className="table__number">Topics</th>
              <th className="table__number">Est. h</th>
              <th>Covered</th>
              <th className="table__number">%</th>
            </tr>
          </thead>
          <tbody>
            {coverage.bySection.map((section) => (
              <tr key={section.key}>
                <td>{section.key}</td>
                <td className="table__number">{section.total}</td>
                <td className="table__number">{section.estHours || "—"}</td>
                <td className="table__bar">
                  <div className="bar">
                    <div className="bar__fill" style={{ width: `${section.coveredPct}%` }} />
                  </div>
                </td>
                <td className="table__number">{section.coveredPct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </fieldset>

      {coverage.archived ? (
        <p className="muted">{coverage.archived} archived topic(s) excluded from these figures.</p>
      ) : null}
    </div>
  );
}
