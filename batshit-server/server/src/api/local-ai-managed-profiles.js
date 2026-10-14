'use strict';
const express = require('express');
const service = require('../services/localAiManagedProfiles');
const router = express.Router();
// This router is mounted ONLY below /api/v1's service-token boundary. It is
// private server-to-server plumbing, never a browser/file/agent writer endpoint.
for (const [action, method] of [['list', 'list'], ['validate', 'validate'], ['prepare', 'prepare'], ['verify', 'verify'], ['revoke', 'revoke'], ['fence-restore', 'fenceRestore'], ['revoke-owner', 'revokeOwner']]) {
  router.post(`/${action}`, async (req, res) => {
    try {
      if (Buffer.byteLength(JSON.stringify(req.body)) > 4096) throw new Error('Managed request exceeds its bound.');
      res.json({ success: true, ...await service[method](req.body) });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message, partial: error.partial === true });
    }
  });
}
module.exports = router;
