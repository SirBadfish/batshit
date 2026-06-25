const express = require('express');
const taskRoutes = require('./task');

const router = express.Router();

router.use('/task', taskRoutes);

// API information
router.get('/', (req, res) => {
  res.json({
    name: 'Batshit-Server API',
    version: '0.1.0',
    endpoints: {
      task: '/task',
      uploads: '/api/upload'
    }
  });
});

module.exports = router;
