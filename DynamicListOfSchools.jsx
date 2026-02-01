// src/components/DynamicListOfSchools.jsx
import React, { useContext } from "react";
import { TaskContext } from "../context/TaskContext";

function DynamicListOfSchools({ activeSchool, setActiveSchool, waitingCountBySchool  }) {
  const { users } = useContext(TaskContext);

  // Extract unique school names
  const uniqueSchools = [...new Set(users.map(user => user.school_name))];
  // Add the "All" option at the beginning
  const schoolTabs = ["All", ...uniqueSchools];


      return (
        <div>
          <div style={{ display: "flex", marginBottom: "1rem" }}>
            {schoolTabs.map((school) => {
              // Get the waiting-task count for this school
              const count = waitingCountBySchool[school] || 0;
    
              return (
                <button
                  key={school}
                  onClick={() => setActiveSchool(school)}
                  style={{
                    padding: "0.5rem 1rem",
                    cursor: "pointer",
                    backgroundColor: activeSchool === school ? "#007bff" : "#f0f0f0",
                    color: activeSchool === school ? "#fff" : "#000",
                    border: "none",
                    borderBottom: activeSchool === school ? "2px solid #0056b3" : "none",
                    marginRight: "0.5rem",
                  }}
                >
                  {school} ({count})
                </button>
              );
            })}
          </div>
        </div>
      );
}

export default DynamicListOfSchools;
