const express = require('express');

const {
  cleanupExpiredStages,
  createStageTicket,
  removeStage,
  stageUpload,
} = require('../services/backupRestoreStagingService');

const router = express.Router();

router.post('/stages', async (req, res) => {
  try {
    await cleanupExpiredStages();
    const result = createStageTicket(req.body || {});
    res.status(201).json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not create backup stage' });
  }
});

router.delete('/stages/:stageId', async (req, res) => {
  try {
    await removeStage(req.params.stageId);
    res.status(204).end();
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not remove backup stage' });
  }
});

async function uploadStageContent(req, res) {
  try {
    const suppliedToken = req.get('x-batshit-upload-ticket');
    const result = await stageUpload({
      stageId: req.params.stageId,
      suppliedToken,
      input: req,
    });
    res.status(201).json({
      staged: true,
      stageId: result.stageId,
      bytes: result.bytes,
      sha256: result.sha256,
      expiresAt: result.expiresAt,
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || 'Could not stage backup' });
  }
}

module.exports = { router, uploadStageContent };
