import React, { useEffect, useState } from "react";
import axios from "axios";
import StatusBudget from "../../components/StatusBudget";

function FetchedBudget() {
  const [year, setYear] = useState("");
  const [month, setMonth] = useState(null);
  const [budget, setBudget] = useState([]); // ✅ start as []

  useEffect(() => {
    const fetchBudgetIds = async () => {
      try {
        const params = {};
        if (year) params.year = year;
        if (month) params.month = month;

        const response = await axios.get("/budget-ids", { params });

        const raw = response.data.budgetIds || [];

        // ✅ normalize to [388,390,391]
        const ids = raw.map((x) => (typeof x === "object" ? x.id : x));

        setBudget(ids);
        console.log("Fetched budget IDs:", ids);
      } catch (error) {
        console.error("Error fetching budget IDs:", error);
      }
    };

    fetchBudgetIds();
  }, [year, month]);

  return (
    <div>
      <select value={year} onChange={(e) => setYear(e.target.value)}>
        <option value="">Select Year</option>
        <option value="2024">2024</option>
        <option value="2025">2025</option>
        <option value="2026">2026</option>

      </select>

      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "8px" }}>
        {Array.from({ length: 12 }, (_, i) => {
          const m = i + 1;
          return (
            <button
              key={m}
              type="button"
              onClick={() => setMonth(m)}
              aria-pressed={month === m}
              style={{
                padding: "6px 10px",
                borderRadius: 4,
                border: month === m ? "2px solid #007bff" : "1px solid #ccc",
                background: month === m ? "#e7f1ff" : "#fff",
                cursor: "pointer",
              }}
            >
              {m}
            </button>
          );
        })}
      </div>

      <div>selected Month: {month}</div>
      <div>selected Year: {year}</div>

      <div>
        <li>{budget.length ? budget.join(", ") : "No budget IDs fetched"}</li>
      </div>

      {/* ✅ passing normalized IDs */}
      <StatusBudget budgetIds={budget} />
    </div>
  );
}

export default FetchedBudget;
