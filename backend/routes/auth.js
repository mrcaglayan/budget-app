// backend/routes/auth.js
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer"); // <-- added for email sending
const cron = require('node-cron');
const pool = require("../db");
require("dotenv").config();

const router = express.Router();
const {
  authenticateToken,
  authenticateAndAttachPermissions,
  authorizeRole
} = require("../middleware/auth");

/**
 *  -------------------------
 *  |  REGISTER NEW USER    |
 *  -------------------------
 */
router.post("/register", async (req, res) => {
  const { name, email, password } = req.body;
  console.log("Registration request:", req.body);

  // 1. Basic validation
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email, password are required" });
  }

  try {
    // 2. Check if email is already in use in the main users table
    pool.query("SELECT id FROM users WHERE email = ?", [email], async (err, results) => {
      if (err) {
        console.error("Database error:", err);
        return res.status(500).json({ error: "Database error" });
      }

      if (results.length > 0) {
        return res.status(400).json({ error: "Email already in use" });
      }

      // 3. Get the default role_id for 'user'
      pool.query("SELECT id FROM roles WHERE role_name = 'user'", async (err, roleResult) => {
        if (err || roleResult.length === 0) {
          console.error("Role fetch error:", err);
          return res.status(500).json({ error: "Failed to fetch default role" });
        }

        const roleId = roleResult[0].id;

        // 4. Generate a verification code (6-digit number)
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

        // 5. Hash the password
        const hashedPassword = await bcrypt.hash(password, 10);

        // 6. Create a JWT token containing the registration details
        // (Do not insert into the database yet.)
        const payload = { name, email, password: hashedPassword, roleId, verificationCode };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "1y" });

        // 7. Send verification email with the token and verification code
        let transporter = nodemailer.createTransport({
          host: "smtp.office365.com",
          port: 587,
          secure: false, // Using STARTTLS
          requireTLS: true,
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
          }
        });

        // Adjust the URL below to match your verification route
        let verificationLink = `https://tracks.tmffinance.com/verify?token=${token}&code=${verificationCode}`;
        console.log("Verification link:", verificationLink);
        let mailOptions = {
          from: process.env.EMAIL_FROM,
          to: email,
          subject: "Email Verification Code",
          text: `Your verification code is ${verificationCode}. Verify your email using this link: ${verificationLink}`
        };
        console.log(verificationLink);

        transporter.sendMail(mailOptions, (err, info) => {
          if (err) {
            console.error("Email error:", err);
            return res.status(500).json({
              error: "Registration succeeded but failed to send verification email",
              details: err.message
            });
          }
          // Optionally return the token to the client (for resending purposes)
          return res.status(200).json({
            message: "Verification email sent. Please check your inbox.",
            token
          });
        });
      });
    });
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: "Server error" });
  }
});


/**
 *  -------------------------
 *  |   VERIFY NEW USER     |
 *  -------------------------
 */
router.get("/verify", async (req, res) => {
  // Expect token and code as query parameters
  const { token, code } = req.query;
  if (!token || !code) {
    return res.status(400).json({ error: "Invalid verification request" });
  }
  try {
    // Decode the token to extract registration details
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.verificationCode !== code) {
      return res.status(400).json({ error: "Invalid verification code" });
    }

    // Check if a user with the given email already exists
    pool.query("SELECT id, is_verified FROM users WHERE email = ?", [payload.email], (err, results) => {
      if (err) {
        console.error("Database error:", err);
        return res.status(500).json({ error: "Database error" });
      }

      // If user exists and is verified, respond with success
      if (results.length > 0) {
        if (results[0].is_verified) {
          return res.status(200).json({ message: "Email already verified." });
        } else {
          // (Optional) If the user exists but is not verified, you might choose to update their status
          pool.query("UPDATE users SET is_verified = ? WHERE id = ?", [true, results[0].id], (err, updateResult) => {
            if (err) {
              console.error("Update error:", err);
              return res.status(500).json({ error: "Failed to update verification status" });
            }
            return res.status(200).json({ message: "Email verified successfully." });
          });
          return;
        }
      }

      // Otherwise, insert the user into the database
      const insertQuery = `
        INSERT INTO users (name, email, password, verification_code, is_verified, role_id, assigned_moderator_id)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
      `;
      pool.query(
        insertQuery,
        [payload.name, payload.email, payload.password, code, true, payload.roleId],
        (err, result) => {
          if (err) {
            console.error("Insert error:", err);
            return res.status(500).json({ error: "Database insertion error" });
          }
          return res.status(201).json({ message: "Email verified and user registered successfully." });
        }
      );
    });
  } catch (error) {
    console.error("Verification error:", error);
    return res.status(400).json({ error: "Invalid or expired token" });
  }
});



/**
 *  ------------------------------
 *  |   RESEND VERIFICATION CODE  |
 *  ------------------------------
 */
router.post("/resend-verification", async (req, res) => {
  // Instead of looking up by email in the users table, we use the token
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: "Token is required to resend verification" });
  }

  try {
    // Decode the existing token to retrieve registration details
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Generate a new verification code
    const newVerificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Create a new token with updated verification code and reset expiration
    const newPayload = { ...payload, verificationCode: newVerificationCode };
    const newToken = jwt.sign(newPayload, process.env.JWT_SECRET, { expiresIn: "1h" });

    // Send the new verification email
    let transporter = nodemailer.createTransport({
      host: "smtp.office365.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    let verificationLink = `http://tracks.tmffinance.com/verify?token=${newToken}&code=${newVerificationCode}`;
    console.log("New verification link:", verificationLink);
    let mailOptions = {
      from: process.env.EMAIL_FROM,
      to: payload.email,
      subject: "Resend Verification Code",
      text: `Your new verification code is ${newVerificationCode}. Verify your email using this link: ${verificationLink}`,
    };

    transporter.sendMail(mailOptions, (err, info) => {
      if (err) {
        console.error("Email error:", err);
        return res.status(500).json({ error: "Failed to send verification email", details: err.message });
      }
      return res.status(200).json({
        message: "Verification email resent successfully",
        token: newToken
      });
    });
  } catch (error) {
    console.error("Token error:", error);
    return res.status(400).json({ error: "Invalid or expired token" });
  }
});

module.exports = router;




/**
 *  -------------------------
 *  |       LOGIN USER      |
 *  -------------------------
 */
router.post("/login", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  pool.query("SELECT * FROM users WHERE email = ?", [email], async (err, results) => {
    if (err || results.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const user = results[0];

    // NEW: Check if the user's email is verified
    if (!user.is_verified) {
      return res.status(401).json({ error: "Please verify your email before logging in." });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Continue with role and permissions fetching...
    pool.query("SELECT role_name FROM roles WHERE id = ?", [user.role_id], (err, roleResult) => {
      if (err || roleResult.length === 0) {
        return res.status(500).json({ error: "Error retrieving role" });
      }

      const role = roleResult[0].role_name;

      pool.query(
        `SELECT p.permission_name 
         FROM permissions p
         JOIN role_permissions rp ON p.id = rp.permission_id
         WHERE rp.role_id = ?`,
        [user.role_id],
        (err, permissionsResult) => {
          if (err) {
            return res.status(500).json({ error: "Error retrieving permissions" });
          }

          const permissions = permissionsResult.map((p) => p.permission_name);

          // Additional query to fetch the school name based on the school_id
          pool.query(
            `SELECT school_name FROM schools WHERE id = ?`,
            [user.school_id],
            (err, schoolResult) => {
              if (err) {
                return res.status(500).json({ error: "Error retrieving school name" });
              }

              const schoolName = schoolResult.length > 0 ? schoolResult[0].school_name : null;

              const token = jwt.sign(
                {
                  id: user.id,
                  name: user.name,
                  role: role,
                  permissions: permissions,
                  school_id: user.school_id,
                  school_name: schoolName,  // Include the school name
                  department_id: user.department_id,
                },
                process.env.JWT_SECRET,
                { expiresIn: "1y" }
              );

              return res.json({
                message: "Login successful",
                token,
                role,
                name: user.name,
                permissions,
                school_id: user.school_id,
                school_name: schoolName,  // Include the school name in the response
                department_id: user.department_id,
              });
            }
          );
        }
      );

    });
  });
});

// backend/routes/auth.js
router.get("/me", authenticateAndAttachPermissions, (req, res) => {
  const { id, name, role, permissions, school_id, school_name, department_id } = req.user;
  return res.json({ id, name, role, permissions, school_id, school_name, department_id });
});

// /auth/forgot-password
router.post("/forgot-password", (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  // 1. Check if user exists
  pool.query("SELECT id, email FROM users WHERE email = ?", [email], (err, results) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).json({ error: "Database error" });
    }

    if (results.length === 0) {
      // Don’t reveal user doesn’t exist; for security, typically say "Check your email"
      return res
        .status(200)
        .json({ message: "If that email is registered, you’ll receive a reset link." });
    }

    const user = results[0];

    // 2. Generate a unique reset token
    const crypto = require("crypto");
    const token = crypto.randomBytes(32).toString("hex");
    // or you could use jwt, but a random string is common

    // 3. Calculate expiry time (e.g., 1 hour from now)
    const expires = new Date(Date.now() + 60 * 60 * 1000);

    // 4. Store token & expiry in the database
    pool.query(
      "UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?",
      [token, expires, user.id],
      (updateErr) => {
        if (updateErr) {
          console.error("Update token error:", updateErr);
          return res.status(500).json({ error: "Database error" });
        }

        // 5. Send email with link
        const resetLink = `https://tracks.tmffinance.com/reset-password?token=${token}`;
        let transporter = nodemailer.createTransport({
          host: "smtp.office365.com",
          port: 587,
          secure: false,
          requireTLS: true,
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          },
        });

        let mailOptions = {
          from: process.env.EMAIL_FROM,
          to: user.email,
          subject: "Password Reset",
          text: `You requested a password reset. Click this link to reset:
${resetLink}
If you did not request this, please ignore this email.`
        };

        transporter.sendMail(mailOptions, (mailErr, info) => {
          if (mailErr) {
            console.error("Email error:", mailErr);
            return res.status(500).json({ error: "Email sending error" });
          }
          return res
            .status(200)
            .json({ message: "If that email is registered, you’ll receive a reset link." });
        });
      }
    );
  });
});


router.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: "Token and new password are required" });
  }

  try {
    // 1. Look up the user with this token
    pool.query(
      "SELECT id, reset_token_expires FROM users WHERE reset_token = ?",
      [token],
      async (err, results) => {
        if (err) {
          console.error("Database error:", err);
          return res.status(500).json({ error: "Database error" });
        }

        if (results.length === 0) {
          return res.status(400).json({ error: "Invalid or expired reset token" });
        }

        const user = results[0];

        // 2. Check if token is expired
        const now = new Date();
        if (now > user.reset_token_expires) {
          return res.status(400).json({ error: "Reset token has expired" });
        }

        // 3. Hash the new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // 4. Update the user’s password & clear the reset token fields
        pool.query(
          "UPDATE users SET password = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?",
          [hashedPassword, user.id],
          (updateErr) => {
            if (updateErr) {
              console.error("Update password error:", updateErr);
              return res.status(500).json({ error: "Database error" });
            }

            return res
              .status(200)
              .json({ message: "Password has been updated successfully" });
          }
        );
      }
    );
  } catch (error) {
    console.error("Reset Password error:", error);
    return res.status(500).json({ error: "Server error" });
  }
});





module.exports = router;
