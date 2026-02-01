// src/pages/budgets/BudgetPerformance.jsx
import React, { useEffect, useState, useMemo } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";
import axios from "axios";
import { FaBalanceScale } from "react-icons/fa";

// Helper functions
const num = (v) => Number(v) || 0;
const fmt2 = (n) =>
  num(n).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const currencyFmt = (v) => (v == null ? "—" : fmt2(v));
const tooltipFormatter = (value, name) => [currencyFmt(value), name];

const normalizeMonthNumber = (value) => {
  if (!Number.isFinite(value)) return null;
  const month = Math.trunc(value);
  if (month < 1 || month > 12) return null;
  return month;
};

const parsePeriod = (value) => {
  if (!value) return null;
  const parts = String(value).split("-");
  if (parts.length !== 2) return null;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  if (parts[0].length === 4 || a > 31) {
    const month = normalizeMonthNumber(b);
    return month ? { year: a, month } : null;
  }
  if (parts[1].length === 4 || b > 31) {
    const month = normalizeMonthNumber(a);
    return month ? { year: b, month } : null;
  }
  const month = normalizeMonthNumber(a);
  return month ? { year: b, month } : null;
};

export default function BudgetPerformance({
  schoolId,
  period,
  selectedYear,
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [series, setSeries] = useState([]);
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [compareYear, setCompareYear] = useState(null);

  useEffect(() => {
    if (!schoolId) return;

    setLoading(true);
    setError(null);

    axios
      .get('/performance', { params: { schoolId } }) // ← minimal swap from fetch → axios
      .then(({ data }) => {
        setSeries(data.performance || []);
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setError(err.response?.data?.error || err.message || 'Error fetching data');
        setLoading(false);
      });
  }, [schoolId]);


  const seriesByYear = useMemo(() => {
    const map = new Map();
    (series || []).forEach((d) => {
      const parts = parsePeriod(d.period);
      if (!parts) return;
      if (!map.has(parts.year)) map.set(parts.year, new Map());
      map.get(parts.year).set(parts.month, {
        asked: num(d.asked),
        approved: num(d.approved),
      });
    });
    return map;
  }, [series]);

  const availableYears = useMemo(() => {
    const years = new Set();
    (series || []).forEach((d) => {
      const parts = parsePeriod(d.period);
      if (parts) years.add(parts.year);
    });
    return Array.from(years).sort((a, b) => a - b);
  }, [series]);

  const baseYear = useMemo(() => {
    const y = Number(selectedYear);
    if (Number.isFinite(y)) return y;
    const fromPeriod = parsePeriod(period)?.year;
    if (Number.isFinite(fromPeriod)) return fromPeriod;
    if (availableYears.length) return Math.max(...availableYears);
    return null;
  }, [availableYears, period, selectedYear]);

  const compareYearOptions = useMemo(() => {
    return availableYears.filter((y) => y !== baseYear);
  }, [availableYears, baseYear]);

  const canCompare = compareYearOptions.length > 0;

  useEffect(() => {
    if (!canCompare && compareEnabled) {
      setCompareEnabled(false);
      return;
    }
    if (!compareEnabled) return;
    const options = compareYearOptions;
    if (!options.length) {
      setCompareYear(null);
      return;
    }
    if (!options.includes(Number(compareYear))) {
      setCompareYear(options[0]);
    }
  }, [canCompare, compareEnabled, compareYear, compareYearOptions]);

  const baseAskedKey = baseYear ? `asked_${baseYear}` : null;
  const baseApprovedKey = baseYear ? `approved_${baseYear}` : null;
  const compareAskedKey =
    compareEnabled && compareYear ? `asked_${compareYear}` : null;
  const compareApprovedKey =
    compareEnabled && compareYear ? `approved_${compareYear}` : null;

  const axisSuffix =
    compareEnabled || !baseYear ? "" : `/${String(baseYear).slice(-2)}`;

  // Normalize series for chart
  const chartData = useMemo(() => {
    if (!baseYear && !(compareEnabled && compareYear)) return [];

    return Array.from({ length: 12 }, (_, idx) => {
      const month = idx + 1;
      const label = `${String(month).padStart(2, "0")}${axisSuffix}`;
      const row = {
        month,
        monthLabel: label,
      };

      if (baseYear && baseAskedKey && baseApprovedKey) {
        const data = seriesByYear.get(baseYear)?.get(month);
        row[baseAskedKey] = data ? num(data.asked) : null;
        row[baseApprovedKey] = data ? num(data.approved) : null;
      }

      if (compareEnabled && compareYear && compareAskedKey && compareApprovedKey) {
        const data = seriesByYear.get(compareYear)?.get(month);
        row[compareAskedKey] = data ? num(data.asked) : null;
        row[compareApprovedKey] = data ? num(data.approved) : null;
      }

      return row;
    });
  }, [
    axisSuffix,
    baseAskedKey,
    baseApprovedKey,
    baseYear,
    compareAskedKey,
    compareApprovedKey,
    compareEnabled,
    compareYear,
    seriesByYear,
  ]);

  const lineDefs = useMemo(() => {
    const defs = [];
    if (baseYear && baseAskedKey && baseApprovedKey) {
      defs.push({
        key: baseAskedKey,
        name: `Asked ${baseYear}`,
        color: "#2563eb",
        dash: null,
      });
      defs.push({
        key: baseApprovedKey,
        name: `Approved ${baseYear}`,
        color: "#059669",
        dash: null,
      });
    }
    if (compareEnabled && compareYear && compareAskedKey && compareApprovedKey) {
      defs.push({
        key: compareAskedKey,
        name: `Asked ${compareYear}`,
        color: "#93c5fd",
        dash: "4 2",
      });
      defs.push({
        key: compareApprovedKey,
        name: `Approved ${compareYear}`,
        color: "#6ee7b7",
        dash: "4 2",
      });
    }
    return defs;
  }, [
    baseAskedKey,
    baseApprovedKey,
    baseYear,
    compareAskedKey,
    compareApprovedKey,
    compareEnabled,
    compareYear,
  ]);

  const hasData = useMemo(() => {
    if (!chartData.length || !lineDefs.length) return false;
    return chartData.some((row) =>
      lineDefs.some((line) => row[line.key] != null)
    );
  }, [chartData, lineDefs]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">Budget Performance</h3>
          <div className="text-xs text-gray-500">
            Year: {baseYear ?? "N/A"}
            {compareEnabled && compareYear ? ` | Compare: ${compareYear}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (!canCompare) return;
              setCompareEnabled((prev) => !prev);
            }}
            aria-pressed={compareEnabled}
            title={canCompare ? "Compare years" : "No other years available"}
            className={[
              "inline-flex items-center justify-center rounded-full border px-2 py-2 text-sm shadow-sm",
              compareEnabled
                ? "border-blue-600 text-blue-600 bg-blue-50"
                : "border-gray-300 text-gray-600 bg-white",
              canCompare ? "hover:bg-gray-50" : "opacity-50 cursor-not-allowed",
            ].join(" ")}
            disabled={!canCompare}
          >
            <FaBalanceScale className="h-4 w-4" />
          </button>
          {compareEnabled && compareYearOptions.length > 0 && (
            <select
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-700"
              value={compareYear ?? ""}
              onChange={(e) => setCompareYear(Number(e.target.value))}
            >
              {compareYearOptions.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {loading ? (
        <div className="h-48 grid place-items-center text-gray-500">Loading…</div>
      ) : error ? (
        <div className="text-red-700 text-sm">Error: {error}</div>
      ) : !hasData ? (
        <div className="text-gray-500 text-sm">No data available.</div>
      ) : (
        <div className="rounded-2xl border p-4">
          <div className="font-semibold mb-2">Asked vs Approved — trend</div>
          <div className="w-full h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="monthLabel" />
                <YAxis tickFormatter={currencyFmt} width={70} />
                <Tooltip formatter={tooltipFormatter} />
                <Legend />
                {lineDefs.map((line) => (
                  <Line
                    key={line.key}
                    type="monotone"
                    dataKey={line.key}
                    name={line.name}
                    stroke={line.color}
                    strokeWidth={2}
                    strokeDasharray={line.dash || undefined}
                    dot={{ r: 2 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
