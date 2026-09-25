const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const c = require('../controllers/notifications.controller');

router.use(requireAuth);

router.get('/', c.getAll);
router.get('/unread-count', c.getUnreadCount);
router.patch('/:id/read', c.markRead);
router.patch('/mark-all-read', c.markAllRead);

module.exports = router;
