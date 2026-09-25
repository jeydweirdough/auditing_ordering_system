const express = require('express');
const router = express.Router();
const { requireTestMode } = require('../middleware/testMode');
const c = require('../controllers/test.controller');

// Status route is always accessible to check if TEST_MODE is active
router.get('/status', c.getStatus);

// All operational test endpoints strictly require TEST_MODE to be enabled
router.use(requireTestMode);

router.get('/accounts', c.getTestAccounts);
router.post('/accounts', c.createBulkAccounts);
router.delete('/accounts', c.cleanupTestAccounts);
router.delete('/accounts/:id', c.deleteSingleAccount);
router.post('/accounts/cleanup', c.cleanupTestAccounts);
router.post('/quick-login', c.quickLogin);

// Demo controls for Scenario 4 (Zoho API downtime)
router.get('/zoho/outage', c.getZohoOutage);
router.post('/zoho/outage', c.setZohoOutage);

module.exports = router;
