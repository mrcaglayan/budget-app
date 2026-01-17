// routes/whatsapp.js
const express = require("express");
const router = express.Router();
const twilio = require("twilio");

// Load Twilio credentials from .env
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

// POST /whatsapp/send
router.post("/send", (req, res) => {
  const { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: "Both 'to' and 'message' fields are required" });
  }

  // Make sure the recipient number is prefixed with 'whatsapp:'
  client.messages
    .create({
      body: message,
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${to}`
    })
    .then((msg) => res.json({ message: "Message sent successfully", sid: msg.sid }))
    .catch((err) => res.status(500).json({ error: "Failed to send message", details: err.message }));
});

module.exports = router;
