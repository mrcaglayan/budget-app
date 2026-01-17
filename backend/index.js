// index.js (backend root)
require('dotenv').config();
require('./services/scheduler');

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { attachChatWs } = require('./server/chatWs');
const jwt = require('jsonwebtoken');

// init DB early (optional)
require('./db');

const app = express();
app.use(express.json());

// In prod, same-origin => CORS usually not needed; keep if you want
app.use(cors());

// ------------------- ROUTES -------------------
const productPreviewRoutes = require('./routes/productPreview');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/user');
const moderatorRoutes = require('./routes/moderator');
const whatsappRoutes = require('./routes/whatsapp');
const purchasingRoutes = require('./purchasingRoutes/userPurchasing');
const modPurchasingRoutes = require('./purchasingRoutes/modPurchasing');
const coordinatorPurchasingRoutes = require('./purchasingRoutes/coordinatorPurchasing');
const muhasebeciRoutes = require('./muhasebeciRoutes/muhasebeAvans');
const adminPurchasingRoutes = require('./purchasingRoutes/adminPurchasing');
const itemsRoutes = require('./routes/items');
const masterAccountRoutes = require('./routes/masterAccounts');
const subAccountRoutes = require('./routes/subAccounts');
const budgetsRoutes = require('./routes/budgets');
const accountAssignmentsRouter = require('./routes/accountAssignments');
const coordinatorBudgetRoutes = require('./routes/budgetApproveCoordinator');
const budgetDraftRoutes = require('./routes/budgetDrafts');
const requestConfirmRoutes = require('./routes/request-confirm');
const budgetsEditorPayload = require('./routes/budgets-editor-payload');
const itemRevise = require('./routes/itemRevise');
const trackRevisions = require('./routes/revisions');
const moderatorControllerRoutes = require('./routes/moderatorBudgetControlling');
const chatRoutes = require('./routes/chat');

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/user', userRoutes);
app.use('/api/moderator', moderatorRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/userPurchasing', purchasingRoutes);
app.use('/api/modPurchasing', modPurchasingRoutes);
app.use('/api/coordinator', coordinatorPurchasingRoutes);
app.use('/api/muhasebeci', muhasebeciRoutes);
app.use('/api/adminPurchasing', adminPurchasingRoutes);

// Core API under /api
app.use('/api', itemsRoutes);
app.use('/api', masterAccountRoutes);
app.use('/api', subAccountRoutes);
app.use('/api', accountAssignmentsRouter);
app.use('/api', budgetsRoutes);
app.use('/api', require('./routes/workflowAssignments'));
app.use('/api', coordinatorBudgetRoutes);
app.use('/api', budgetDraftRoutes);
app.use('/api', requestConfirmRoutes);
app.use('/api', budgetsEditorPayload);
app.use('/api', require('./routes/adminBudgetDrafts'));
app.use('/api', require('./routes/assignments'));
app.use('/api', require('./routes/departments'));
app.use('/api', require('./routes/departmentsCRUD'));
app.use('/api', productPreviewRoutes);
app.use('/api/excel', require('./routes/excelReports'));
app.use('/api', itemRevise);
app.use('/api/budgets', require('./routes/ReviewBudgetRequested'));
app.use('/api', trackRevisions);
app.use('/api', moderatorControllerRoutes);
app.use('/api', require('./routes/budgetReset'));
app.use('/api', require('./routes/bulkApprove'));
app.use('/api', require('./routes/itemApproveNotes'));
app.use('/api', require('./routes/bulkPostpone'));
app.use('/api', require('./routes/itemPostponeNotes'));
app.use('/api', require('./routes/performanceSummary'));
app.use('/api', require('./routes/SummaryBudget'));
app.use('/api', require('./routes/accountGroupingSettings'));
app.use('/api', require('./routes/controlingApi/stageCounts'));
app.use('/api', require('./routes/controlingApi/logisticsStage'));
app.use('/api', require('./routes/controlingApi/neededStage'));
app.use('/api', require('./routes/controlingApi/costStage'));
app.use('/api', require('./routes/workflow/workflowRoute'));
app.use('/api/chat', chatRoutes);
app.use('/api', require('./routes/budgetListFetch'));
app.use('/api', require('./routes/numberOfStudents'));
app.use('/api', require('./routes/kitchenCalories'))
app.use('/api', require('./routes/budgetIds'));

// Return JSON 404 for unknown /api/* so React fallback doesn't swallow API errors
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ------------------- STATIC REACT BUILD -------------------
// You said the build folder sits at backend/build
const buildDir = path.join(__dirname, 'build');

// Cache static assets; index.html should not be aggressively cached
app.use(express.static(buildDir, { maxAge: '1y', index: false }));

// SPA fallback for non-API routes (exclude server prefixes to be safe)
app.get(/^\/(?!api\/|auth\/|admin\/|user\/|moderator\/|whatsapp\/|userPurchasing\/|modPurchasing\/|coordinator\/|muhasebeci\/|adminPurchasing\/).*/, (req, res) => {
  res.sendFile(path.join(buildDir, 'index.html'));
});

// ------------------- HTTP + WS on same port -------------------
const server = http.createServer(app);
// ✅ Use the module that knows how to handle 'sub'/'unsub' and keeps thread subscriptions
attachChatWs(server, { jwtSecret: process.env.JWT_SECRET });

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log('HTTP+WS listening on', PORT));