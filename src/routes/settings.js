const express = require('express');
const config = require('../config');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

router.get('/', (req, res) => {
  res.json({ storeName: config.storeName });
});

module.exports = router;
