import { VARIATION_METRICS, buildVariationRows } from '../quarterlyVariation.js';

const TONE_CLASS = {
  good: 'text-status-positive',
  bad: 'text-status-negative',
  neutral: 'text-on-surface',
};

export default function QuarterlyVariationTable({ qoq }) {
  const rows = buildVariationRows(qoq);
  if (!rows.length) return null;

  return (
    <div className="bg-white rounded-2xl shadow-elevation-1 p-6">
      <h2 className="text-base font-semibold text-on-surface mb-4">
        Quarterly Variation
      </h2>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm border-collapse">
          <thead>
            <tr className="bg-surface-dim text-on-surface-secondary">
              <th
                rowSpan={2}
                className="px-3 py-2 text-left text-xs font-medium border-r border-surface-border align-bottom"
              >
                Quarter
              </th>
              {VARIATION_METRICS.map(({ key, label }) => (
                <th
                  key={key}
                  colSpan={2}
                  className="px-2 py-2 text-center text-xs font-medium border-l border-surface-border"
                >
                  {label}
                </th>
              ))}
            </tr>
            <tr className="bg-surface-dim text-on-surface-secondary">
              {VARIATION_METRICS.flatMap(({ key }) => [
                <th
                  key={`${key}-qoq`}
                  className="px-2 py-1.5 text-right text-xs font-normal border-l border-surface-border w-24"
                >
                  QoQ
                </th>,
                <th
                  key={`${key}-yoy`}
                  className="px-2 py-1.5 text-right text-xs font-normal w-24"
                >
                  YoY
                </th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.quarter} className="border-t border-surface-border">
                <td className="px-3 py-2 text-left font-medium text-on-surface border-r border-surface-border whitespace-nowrap">
                  {row.quarter}
                </td>
                {row.cells.map((cell, i) => (
                  <td
                    key={cell.id}
                    className={`px-2 py-2 text-right whitespace-nowrap ${
                      i % 2 === 0 ? 'border-l border-surface-border' : ''
                    }`}
                  >
                    <div className={`font-medium ${TONE_CLASS[cell.tone]}`}>{cell.primary}</div>
                    {cell.secondary && (
                      <div className="text-xs text-on-surface-secondary">{cell.secondary}</div>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-on-surface-secondary">
        QoQ compares consecutive quarters — Q1 is measured against the prior Q4. A percentage is
        shown only where the baseline is positive; elsewhere the absolute change stands alone.
      </p>
    </div>
  );
}
