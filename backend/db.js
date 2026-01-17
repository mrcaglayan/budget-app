// db.js
const mysql = require("mysql2");

const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "1212",
  database: "task_tracker",
  waitForConnections: true,
  connectionLimit: 10, // Adjust based on your load
  queueLimit: 0
});

module.exports = pool;
